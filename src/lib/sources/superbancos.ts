import { cached, fetchT, fmtDate } from '../http';
import { LEVEL_RANK, matchEntity, orgTokens, type MatchLevel } from '../match';
import type { Field, Source, Table } from '../types';
import { sriLookup } from './sri';

/**
 * Superintendencia de Bancos (SB).
 * Publica en su sitio (WordPress, API REST pública) dos listas que sí son de consulta abierta:
 *  - Entidades NO autorizadas a realizar actividades financieras (captación ilegal, préstamos), por año.
 *  - Catastro de bancos autorizados y controlados.
 * El registro crediticio y el certificado de titulares de cuenta corriente solo los obtiene el propio
 * titular con usuario en appweb.superbancos.gob.ec, por eso no se automatizan.
 */
const API = 'https://www.superbancos.gob.ec/bancos/wp-json/wp/v2/posts';
const TTL = 6 * 60 * 60_000;

const NO_AUTORIZADAS = [
  { id: 41295, url: 'https://www.superbancos.gob.ec/bancos/entidades-no-autorizadas-por-la-sb-para-realizar-actividades-financieras-2025-2026/' },
  { id: 1142, url: 'https://www.superbancos.gob.ec/bancos/listado-de-entidades-no-autorizadas-a-operar-en-el-pais/' },
];
const CATASTRO = { id: 904, url: 'https://www.superbancos.gob.ec/bancos/catastro-publico/' };

interface Entry {
  name: string;
  group: string;
  url: string;
  tokens: string[];
  /** variantes: nombre completo y cada parte separada por guion (marca - nombre comercial) */
  keys: string[][];
}

const entry = (name: string, group: string, url: string): Entry => {
  const tokens = orgTokens(name);
  const parts = name.split(/\s*-\s*/).filter((p) => p.trim() && p.trim() !== name.trim());
  return { name, group, url, tokens, keys: [tokens, ...parts.map(orgTokens)].filter((k) => k.length) };
};

const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8211;|&ndash;/g, '-')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

async function getPost(id: number) {
  const res = await fetchT(`${API}/${id}?_fields=content,modified`, {}, 20000);
  if (!res.ok) throw new Error(`Superintendencia de Bancos respondió ${res.status}`);
  return (await res.json()) as { content: { rendered: string }; modified: string };
}

/** Celdas "N. NOMBRE"; el año sale del último encabezado "Año 2025" / "Entidades detectadas 2026" visto. */
function parseNoAutorizadas(html: string, url: string): Entry[] {
  const out: Entry[] = [];
  let group = '';
  for (const m of html.matchAll(/<(h\d|p|strong|span|a|div)\b[^>]*>([^<]{3,60})<\/\1>|<td\b[^>]*>([\s\S]*?)<\/td>/g)) {
    if (m[2]) {
      const t = text(m[2]);
      const y = t.match(/^(?:Año|Entidades detectadas)\s+(\d{4})$/i);
      if (y) group = y[1];
      else if (/^Otros Años$/i.test(t)) group = 'Años anteriores';
      continue;
    }
    for (const line of (m[3] ?? '').split(/<br\s*\/?>|<\/p>/i)) {
      const t = text(line).replace(/\s*\*$/, '');
      const e = t.match(/^\d{1,3}\.\s*(.{2,120})$/);
      if (e) out.push(entry(e[1].trim(), group || '—', url));
    }
  }
  return out;
}

function parseCatastro(html: string): Entry[] {
  const out: Entry[] = [];
  for (const m of html.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/g)) {
    const t = text(m[1]);
    if (/^(BANCO|BANECUADOR|CITIBANK|CORPORACION FINANCIERA)/i.test(t) && t.length < 90) {
      out.push(entry(t, 'Banco autorizado', CATASTRO.url));
    }
  }
  return out;
}

function loadLists() {
  return cached('superbancos:listas:v2', TTL, async () => {
    const [na1, na2, cat] = await Promise.all([getPost(NO_AUTORIZADAS[0].id), getPost(NO_AUTORIZADAS[1].id), getPost(CATASTRO.id)]);
    const noAut = [...parseNoAutorizadas(na1.content.rendered, NO_AUTORIZADAS[0].url), ...parseNoAutorizadas(na2.content.rendered, NO_AUTORIZADAS[1].url)];
    const seen = new Set<string>();
    const dedup = noAut.filter((e) => {
      const k = `${e.tokens.join(' ')}|${e.group}`;
      return seen.has(k) ? false : (seen.add(k), true);
    });
    if (!dedup.length) throw new Error('El listado de entidades no autorizadas cambió de formato.');
    const updated = [na1.modified, na2.modified].sort().pop() ?? '';
    return { noAut: dedup, bancos: parseCatastro(cat.content.rendered), updated };
  });
}

type Hit = { e: Entry; level: MatchLevel };
const find = (q: string[], list: Entry[]): Hit[] =>
  list
    .map((e) => {
      const levels = e.keys.map((k) => matchEntity(q, k)).filter((l): l is MatchLevel => !!l);
      return { e, level: levels.sort((a, b) => LEVEL_RANK[a] - LEVEL_RANK[b])[0] ?? null };
    })
    .filter((h): h is Hit => !!h.level)
    .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
    .slice(0, 15);

export const superbancos: Source = {
  id: 'superbancos',
  name: 'Entidades no autorizadas y catastro',
  institution: 'Superintendencia de Bancos',
  officialUrl: NO_AUTORIZADAS[0].url,
  supports: ['cedula', 'ruc', 'nombre'],
  async run(q) {
    const name = q.kind === 'nombre' ? q.value : ((await sriLookup(q.value).catch(() => null))?.razonSocial ?? '');
    const personal =
      'El registro crediticio (deudas y calificación) y el certificado de titulares de cuenta corriente (habilitado/inhabilitado por cheques protestados) ' +
      'solo los obtiene el propio titular, con usuario en appweb.superbancos.gob.ec.';
    if (!name) {
      return { status: 'empty', summary: 'No hay nombre para cotejar (la cédula no tiene RUC).', note: personal };
    }

    const { noAut, bancos, updated } = await loadLists();
    const qt = orgTokens(name);
    const bad = find(qt, noAut);
    const ok = q.mode === 'empresa' ? find(qt, bancos).filter((h) => h.level !== 'Parcial') : [];

    const stats: Field[] = [
      { label: 'Entidades no autorizadas revisadas', value: String(noAut.length) },
      { label: 'Última actualización', value: fmtDate(updated.slice(0, 10)) },
    ];
    const tables: Table[] = [];
    if (bad.length) {
      tables.push({
        title: 'Coincidencias en entidades NO autorizadas',
        columns: ['Coincidencia', 'Nombre publicado por la SB', 'Detectada', 'Listado'],
        rows: bad.map(({ e, level }) => [level, e.name, e.group, { text: 'Ver listado ↗', href: e.url }]),
      });
    }
    if (ok.length) {
      tables.push({
        title: 'Catastro: entidad autorizada',
        columns: ['Coincidencia', 'Banco', 'Estado'],
        rows: ok.map(({ e, level }) => [level, e.name, 'Autorizado y controlado por la SB']),
      });
    }

    const note =
      'Figurar como "no autorizada" significa que la SB detectó que ofrece servicios financieros (préstamos, captación) sin autorización (COMF, art. 254). ' +
      personal;

    if (bad.length) {
      return {
        status: 'ok',
        summary: `⚠ ${bad.length} posible(s) coincidencia(s) en el listado de entidades NO autorizadas por la Superintendencia de Bancos.`,
        stats: [{ label: 'Coincidencias', value: String(bad.length) }, ...stats],
        tables,
        note: '⚠ Una coincidencia de nombre comercial no confirma que sea la misma persona o empresa. ' + note,
      };
    }
    if (ok.length) {
      return { status: 'ok', summary: `${ok[0].e.name} es un banco autorizado y controlado por la Superintendencia de Bancos.`, stats, tables, note };
    }
    return {
      status: 'empty',
      summary: `«${name}» no consta en el listado de entidades no autorizadas de la Superintendencia de Bancos.`,
      stats,
      note,
    };
  },
};
