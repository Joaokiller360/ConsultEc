import { cached, fetchT, fmtDate } from '../http';
import type { Source, Table } from '../types';
import { sriLookup } from './sri';

/**
 * Listas restrictivas de la UAFE.
 *
 * La UAFE exige a los sujetos obligados cotejar a sus clientes contra la Lista Consolidada de
 * Sanciones del Consejo de Seguridad de la ONU (terrorismo, proliferación, embargos), y la difunde en
 * https://www.uafe.gob.ec/resoluciones-de-la-onu-por-sanciones-o-exenciones-a-personas-naturales-o-juridicas/
 * La lista es pública (XML oficial en español); se descarga y se guarda en memoria 12 h.
 *
 * Los reportes de operaciones sospechosas son reservados por ley y no se pueden consultar.
 * El código de registro UAFE y el certificado de cumplimiento solo se consultan con usuario en
 * SISLAFT, por lo que no se automatizan.
 */
const UN_XML = 'https://scsanctions.un.org/resources/xml/sp/consolidated.xml';
const TTL = 12 * 60 * 60_000;

interface UnEntry {
  kind: 'Persona' | 'Entidad';
  ref: string;
  listType: string;
  name: string;
  aliases: string[];
  listedOn: string;
  nationality: string;
  documents: string[];
  comments: string;
  /** conjuntos de tokens normalizados: nombre principal + cada alias */
  keys: Set<string>[];
  docKeys: string[];
}

const STOP = new Set([
  'DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'Y', 'E', 'AL', 'BIN', 'BEN', 'IBN', 'ABU', 'ABD',
  'SA', 'S', 'A', 'CIA', 'LTDA', 'CA', 'C', 'SAS', 'BIC', 'EP', 'CO', 'INC', 'LTD', 'LLC', 'COMPANIA', 'LIMITADA', 'ANONIMA', 'SOCIEDAD',
]);

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const tokens = (s: string) => new Set(norm(s).split(' ').filter((t) => t.length > 1 && !STOP.has(t)));

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/&amp;/g, '&')
    .trim();

const tag = (xml: string, t: string) => {
  const m = xml.match(new RegExp(`<${t}>([\\s\\S]*?)</${t}>`));
  return m ? decode(m[1]) : '';
};
const blocks = (xml: string, t: string) => xml.match(new RegExp(`<${t}>[\\s\\S]*?</${t}>`, 'g')) ?? [];
const values = (xml: string, t: string) => blocks(xml, t).flatMap((b) => blocks(b, 'VALUE').map((v) => tag(v, 'VALUE'))).filter(Boolean);

function parse(xml: string): { generated: string; entries: UnEntry[] } {
  const generated = xml.match(/dateGenerated="([^"]+)"/)?.[1] ?? '';
  const entries: UnEntry[] = [];
  for (const [blockTag, kind, aliasTag] of [
    ['INDIVIDUAL', 'Persona', 'INDIVIDUAL_ALIAS'],
    ['ENTITY', 'Entidad', 'ENTITY_ALIAS'],
  ] as const) {
    for (const b of blocks(xml, blockTag)) {
      const name = ['FIRST_NAME', 'SECOND_NAME', 'THIRD_NAME', 'FOURTH_NAME'].map((t) => tag(b, t)).filter(Boolean).join(' ');
      if (!name) continue;
      const aliases = blocks(b, aliasTag).map((a) => tag(a, 'ALIAS_NAME')).filter(Boolean);
      const docs = blocks(b, 'INDIVIDUAL_DOCUMENT')
        .map((d) => ({ type: tag(d, 'TYPE_OF_DOCUMENT'), num: tag(d, 'NUMBER'), country: tag(d, 'ISSUING_COUNTRY') }))
        .filter((d) => d.num);
      entries.push({
        kind,
        ref: tag(b, 'REFERENCE_NUMBER'),
        listType: tag(b, 'UN_LIST_TYPE'),
        name,
        aliases,
        listedOn: tag(b, 'LISTED_ON'),
        nationality: values(b, 'NATIONALITY').join(', '),
        documents: docs.map((d) => [d.type, d.num, d.country].filter(Boolean).join(' · ')),
        comments: tag(b, 'COMMENTS1'),
        keys: [name, ...aliases].map(tokens).filter((k) => k.size > 0),
        docKeys: docs.map((d) => d.num.replace(/\D/g, '')).filter((d) => d.length >= 6),
      });
    }
  }
  return { generated, entries };
}

type UnList = ReturnType<typeof parse>;
let inflight: Promise<UnList> | null = null;

/** Descarga compartida: la precarga y las búsquedas simultáneas esperan la misma petición. */
function loadList(): Promise<UnList> {
  inflight ??= cached('uafe:onu', TTL, async () => {
    const res = await fetchT(UN_XML, { headers: { Accept: 'application/xml' } }, 60000);
    if (!res.ok) throw new Error(`Lista ONU respondió ${res.status}`);
    const parsed = parse(await res.text());
    if (!parsed.entries.length) throw new Error('La lista ONU llegó vacía o cambió de formato.');
    return parsed;
  }).finally(() => {
    inflight = null;
  });
  return inflight;
}

// Precarga en segundo plano al iniciar el servidor: la primera descarga tarda ~30 s.
loadList().catch(() => {});

type Match = { e: UnEntry; exact: boolean };

/**
 * Coincidencia por tokens: todas las palabras significativas de la búsqueda deben estar en el
 * nombre (o alias) listado, o todas las del nombre listado en la búsqueda. Se exigen ≥2 palabras
 * para evitar falsos positivos con un solo apellido.
 */
function matchName(query: string, entries: UnEntry[]): Match[] {
  const q = tokens(query);
  if (q.size < 2 && !(q.size === 1 && [...q][0].length >= 5)) return [];
  const out: Match[] = [];
  for (const e of entries) {
    let best: Match | null = null;
    for (const k of e.keys) {
      const qInK = [...q].every((t) => k.has(t));
      const kInQ = k.size >= 2 && [...k].every((t) => q.has(t));
      if (qInK || kInQ) {
        const exact = qInK && kInQ;
        if (!best || exact) best = { e, exact };
        if (exact) break;
      }
    }
    // una sola palabra (p. ej. razón social corta) solo cuenta si es idéntica al nombre/alias
    if (best && q.size === 1 && !best.exact) best = null;
    if (best) out.push(best);
  }
  return out.sort((a, b) => Number(b.exact) - Number(a.exact)).slice(0, 25);
}

const LIST_NAMES: Record<string, string> = {
  'Al-Qaida': 'EIIL (Dáesh) y Al-Qaida (1267)',
  Taliban: 'Talibán (1988)',
  DPRK: 'RPD de Corea (1718)',
  Iran: 'Irán (2231)',
  Iraq: 'Irak (1518)',
  Libya: 'Libia (1970)',
  DRC: 'R. D. del Congo (1533)',
  Sudan: 'Sudán (1591)',
  SouthSudan: 'Sudán del Sur (2206)',
  Somalia: 'Al-Shabaab (2713)',
  CAR: 'Rep. Centroafricana (2127)',
  Yemen: 'Yemen (2140)',
  Mali: 'Malí (2374)',
  Haiti: 'Haití (2653)',
};

export const uafe: Source = {
  id: 'uafe',
  name: 'Listas restrictivas (ONU)',
  institution: 'UAFE',
  officialUrl: 'https://www.uafe.gob.ec/resoluciones-de-la-onu-por-sanciones-o-exenciones-a-personas-naturales-o-juridicas/',
  supports: ['cedula', 'ruc', 'nombre'],
  async run(q) {
    // Para cédula/RUC se toma el nombre del SRI; además se busca el número en los documentos listados.
    let name = q.kind === 'nombre' ? q.value : '';
    if (!name) {
      try {
        name = (await sriLookup(q.value))?.razonSocial ?? '';
      } catch {
        /* sin SRI: solo búsqueda por documento */
      }
    }

    const { generated, entries } = await loadList();
    const id = q.kind === 'nombre' ? '' : q.value.slice(0, 10);
    const byDoc = id ? entries.filter((e) => e.docKeys.some((d) => d.includes(id))) : [];
    const byName = name ? matchName(name, entries) : [];
    const seen = new Set<string>();
    const hits: Match[] = [...byDoc.map((e) => ({ e, exact: true })), ...byName].filter((m) =>
      seen.has(m.e.ref) ? false : (seen.add(m.e.ref), true),
    );

    const stats = [
      { label: 'Registros revisados', value: entries.length.toLocaleString('es-EC') },
      { label: 'Lista actualizada', value: fmtDate(generated.slice(0, 10)) },
    ];
    const note =
      'Lista Consolidada del Consejo de Seguridad de la ONU, de cotejo obligatorio para los sujetos obligados ante la UAFE. ' +
      'Los reportes de operaciones sospechosas de la UAFE son reservados por ley y no se publican. ' +
      'El código de registro y el certificado de cumplimiento UAFE solo se consultan con usuario en sislaft.uafe.gob.ec.';

    if (!name && !id) {
      return { status: 'empty', summary: 'No hay nombre para cotejar.', stats, note };
    }
    if (!hits.length) {
      return {
        status: 'empty',
        summary: name
          ? `No consta en las listas restrictivas de la ONU que difunde la UAFE («${name}»).`
          : 'No consta por número de documento (la cédula no tiene RUC, no se pudo cotejar por nombre).',
        stats,
        note,
      };
    }

    const exact = hits.filter((h) => h.exact).length;
    const tables: Table[] = [
      {
        title: 'Coincidencias',
        columns: ['Coincidencia', 'Tipo', 'Nombre listado', 'Alias', 'Régimen', 'Ref. ONU', 'Incluido', 'Nacionalidad'],
        rows: hits.map(({ e, exact }) => [
          exact ? 'Exacta' : 'Parcial',
          e.kind,
          e.name,
          e.aliases.slice(0, 4).join(' · ') || '—',
          LIST_NAMES[e.listType] ?? e.listType,
          e.ref,
          fmtDate(e.listedOn),
          e.nationality || '—',
        ]),
      },
    ];
    const withDocs = hits.filter((h) => h.e.documents.length);
    if (withDocs.length) {
      tables.push({
        title: 'Documentos registrados',
        columns: ['Ref. ONU', 'Documento'],
        rows: withDocs.flatMap(({ e }) => e.documents.map((d) => [e.ref, d])),
      });
    }

    return {
      status: 'ok',
      summary: `${hits.length} posible(s) coincidencia(s) en la lista de sanciones de la ONU${exact ? ` · ${exact} exacta(s)` : ''}. Verificar identidad antes de concluir.`,
      stats: [{ label: 'Coincidencias', value: String(hits.length) }, ...stats],
      tables,
      note:
        '⚠ Una coincidencia de nombre no confirma identidad: compara fecha de nacimiento, nacionalidad y documentos. ' + note,
    };
  },
};
