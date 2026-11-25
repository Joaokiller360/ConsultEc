import { cached, fetchT, fmtDate } from '../http';
import { LEVEL_RANK, matchLevel, nameTokens, type MatchLevel } from '../match';
import type { Field, Source, Table } from '../types';
import { sriLookup } from './sri';

/**
 * Programa "Los Más Buscados" de la Policía Nacional.
 * Las fichas están publicadas como texto en páginas de WordPress de policia.gob.ec; se leen por la
 * API REST pública de WordPress (wp-json) y se guardan en memoria 2 h.
 */
const API = 'https://www.policia.gob.ec/wp-json/wp/v2/pages';
const TTL = 2 * 60 * 60_000;

const LISTS = [
  { id: 23797, name: 'Delitos del ejercicio público', url: 'https://www.policia.gob.ec/losmasbuscados_delitos_ejercicio_publico_new/' },
  { id: 18479, name: 'Violencia de género', url: 'https://www.policia.gob.ec/losmasbuscados-violenciadegenero/' },
  { id: 18940, name: 'Delitos de corrupción', url: 'https://www.policia.gob.ec/mas-buscados-por-delitos-de-corrupcion/' },
  { id: 23835, name: 'Localizados fuera del país', url: 'https://www.policia.gob.ec/localizados-fuera-del-pais/' },
];

interface Wanted {
  list: string;
  listUrl: string;
  updated: string;
  name: string;
  alias: string;
  edad: string;
  delito: string;
  gdo: string;
  photo: string;
  tokens: string[];
}

const text = (s: string) =>
  s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#8211;|&ndash;/g, '–')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();

/**
 * Cada ficha es un <h6>/<p> con líneas separadas por <br>: nombre, ALIAS:, EDAD:, DELITO: (varias líneas), GDO:.
 * La foto es el background-image del bloque inmediatamente anterior.
 */
function parsePage(html: string, list: (typeof LISTS)[number], updated: string): Wanted[] {
  const out: Wanted[] = [];
  let photo = '';
  for (const m of html.matchAll(/background-image:\s*url\(['"]?([^'")]+)['"]?\)|<(h\d|p)\b[^>]*>([\s\S]*?)<\/\2>/g)) {
    if (m[1]) {
      photo = m[1].startsWith('https://www.policia.gob.ec/') ? m[1] : '';
      continue;
    }
    const lines = m[3].split(/<br\s*\/?>/i).map(text).filter(Boolean);
    if (!lines.some((l) => /^EDAD\s*:/i.test(l))) continue;
    const nameParts: string[] = [];
    const kv: Record<string, string[]> = {};
    let key = '';
    for (const l of lines) {
      const km = l.match(/^(ALIAS|EDAD|DELITO|GDO)\s*:\s*(.*)$/i);
      if (km) {
        key = km[1].toUpperCase();
        (kv[key] ??= []).push(km[2]);
      } else if (key) kv[key].push(l);
      else nameParts.push(l);
    }
    const name = nameParts.join(' ');
    if (!name) continue;
    const get = (k: string, sep = ' ') => (kv[k] ?? []).filter(Boolean).join(sep);
    out.push({
      list: list.name,
      listUrl: list.url,
      updated,
      name,
      alias: get('ALIAS'),
      edad: get('EDAD'),
      delito: get('DELITO', ' / ').replace(/\s*\/\s*$/, ''),
      gdo: get('GDO'),
      photo,
      tokens: nameTokens(name),
    });
    photo = '';
  }
  return out;
}

function loadAll(): Promise<Wanted[]> {
  return cached('policia:buscados:v2', TTL, async () => {
    const pages = await Promise.all(
      LISTS.map(async (l) => {
        const res = await fetchT(`${API}/${l.id}?_fields=content,modified`, {}, 20000);
        if (!res.ok) throw new Error(`Policía Nacional respondió ${res.status}`);
        const d = (await res.json()) as { content: { rendered: string }; modified: string };
        return parsePage(d.content.rendered, l, d.modified);
      }),
    );
    const all = pages.flat();
    if (!all.length) throw new Error('La lista de Más Buscados cambió de formato.');
    return all;
  });
}

/** Nombre a cotejar: el escrito, o el del SRI si se buscó por cédula. */
async function subjectName(q: { kind: string; value: string }) {
  if (q.kind === 'nombre') return q.value;
  return (await sriLookup(q.value).catch(() => null))?.razonSocial ?? '';
}

export const policia: Source = {
  id: 'policia',
  name: 'Los Más Buscados',
  institution: 'Policía Nacional',
  officialUrl: 'https://www.policia.gob.ec/programa-los-mas-buscados/',
  supports: ['cedula', 'nombre'],
  async run(q) {
    const name = await subjectName(q);
    if (!name) {
      return {
        status: 'empty',
        summary: 'Las listas no tienen cédula y esta cédula no tiene RUC para obtener el nombre: busca por apellidos y nombres.',
      };
    }

    const all = await loadAll();
    const qt = nameTokens(name);
    const hits = all
      .map((w) => ({ w, level: matchLevel(qt, w.tokens) }))
      .filter((h): h is { w: Wanted; level: MatchLevel } => !!h.level)
      .sort((a, b) => LEVEL_RANK[a.level] - LEVEL_RANK[b.level])
      .slice(0, 20);

    const updated = all.reduce((m, w) => (w.updated > m ? w.updated : m), '');
    const stats: Field[] = [
      { label: 'Fichas revisadas', value: String(all.length) },
      { label: 'Listas', value: String(LISTS.length) },
      { label: 'Última actualización', value: fmtDate(updated) },
    ];
    const note =
      'Listas publicadas por la Policía Nacional (delitos del ejercicio público, violencia de género, corrupción y localizados fuera del país). ' +
      'Pueden incluir personas ya capturadas que aún no se retiran de la web. Información: 1800 DELITO (335486).';

    if (!hits.length) {
      return { status: 'empty', summary: `«${name}» no figura en las listas de Los Más Buscados.`, stats, note };
    }

    const table: Table = {
      title: 'Coincidencias',
      columns: ['Foto', 'Coincidencia', 'Nombre en la lista', 'Alias', 'Edad', 'Delito', 'Grupo', 'Lista'],
      rows: hits.map(({ w, level }) => [
        w.photo ? { img: w.photo, alt: w.name } : '—',
        level,
        w.name,
        w.alias || '—',
        w.edad || '—',
        w.delito || '—',
        w.gdo || '—',
        { text: w.list, href: w.listUrl },
      ]),
    };
    const strong = hits.filter((h) => h.level !== 'Parcial').length;
    return {
      status: 'ok',
      summary: `${hits.length} posible(s) coincidencia(s) en Los Más Buscados${strong ? ` · ${strong} con el nombre completo` : ''}.`,
      stats: [{ label: 'Coincidencias', value: String(hits.length) }, ...stats],
      tables: [table],
      note:
        '⚠ La lista no publica cédulas: una coincidencia de nombre no confirma identidad (compara edad y foto). ' +
        '"Probable" = nombre completo con diferencia de una letra. ' +
        note,
    };
  },
};

/**
 * Notificaciones rojas de INTERPOL. Su API pública (ws-public.interpol.int) rechaza peticiones desde
 * servidores, pero admite las del navegador (CORS), igual que su propio buscador. El servidor solo
 * resuelve el nombre; la búsqueda la hace el navegador del usuario (ver interpolSearch en index.astro).
 * Si el navegador no puede, la tarjeta queda con el enlace oficial.
 */
export const interpol: Source = {
  id: 'interpol',
  name: 'Notificaciones rojas',
  institution: 'INTERPOL',
  officialUrl: 'https://www.interpol.int/es/Como-trabajamos/Notificaciones/Notificaciones-rojas/Ver-las-notificaciones-rojas',
  supports: ['cedula', 'nombre'],
  async run(q) {
    const name = await subjectName(q);
    return {
      status: 'manual',
      summary: name
        ? 'Busca en el portal de INTERPOL por apellidos y nombres, con nacionalidad Ecuador.'
        : 'Esta cédula no tiene RUC para obtener el nombre: busca por apellidos y nombres.',
      fields: name ? [{ label: 'Nombre a buscar', value: name }] : undefined,
      note:
        'Solo se publican las notificaciones rojas que el país solicitante autoriza; muchas son reservadas. ' +
        'Las notificaciones especiales INTERPOL–ONU ya se cotejan en la tarjeta UAFE.',
    };
  },
};
