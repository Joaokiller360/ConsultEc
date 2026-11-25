import { audit, buildJsonRequest, loadConvenio, pick, str, unwrap, type ConvenioConfig } from '../convenio';
import { cached, fetchT, fmtDate } from '../http';
import type { Query, Source, Table } from '../types';
import { supercias as manual } from './manual';

/**
 * Documentos societarios (Superintendencia de Compañías, Valores y Seguros) vía servicio web
 * de CONVENIO. El portal público usa Google reCAPTCHA, por lo que no se consulta automáticamente.
 *
 * Se activa con SUPERCIAS_API_URL y SUPERCIAS_API_KEY. Sin ellas, la tarjeta queda en modo manual.
 *
 * ⚙ Con la especificación oficial, ajusta SOLO `buildRequest()` y `parseResponse()`.
 *   La UI espera las tres pestañas del portal: Generales, Jurídicos y Económicos.
 */

const config = () => loadConvenio('SUPERCIAS_');
export const superciasConvenioActivo = () => config() !== null;

/* ───────── adaptar a la especificación oficial ───────── */

function buildRequest(c: ConvenioConfig, q: Query) {
  return buildJsonRequest(
    c,
    q.kind === 'ruc' ? { tipoBusqueda: 'RUC', ruc: q.value } : { tipoBusqueda: 'NOMBRE', nombre: q.value },
  );
}

type Link = { text: string; href: string } | string;

export interface Documento {
  expediente?: string;
  descripcion?: string;
  resolucion?: string;
  actoJuridico?: string;
  idDocumento?: string;
  fecha?: string;
  url?: string;
}

export interface SuperciasResult {
  compania?: {
    nombre?: string;
    expediente?: string;
    ruc?: string;
    situacionLegal?: string;
    tipo?: string;
    fechaConstitucion?: string;
    capitalSuscrito?: string;
  };
  generales: Documento[];
  juridicos: Documento[];
  economicos: Documento[];
  mensaje?: string;
}

type Obj = Record<string, unknown>;

function toDoc(o: Obj): Documento {
  return {
    expediente: str(pick(o, 'expediente', 'numeroExpediente')),
    descripcion: str(pick(o, 'descripcion', 'descripcionDocumento', 'documento', 'nombreDocumento')),
    resolucion: str(pick(o, 'resolucion', 'numeroResolucion')),
    actoJuridico: str(pick(o, 'actoJuridico', 'acto')),
    idDocumento: str(pick(o, 'idDocumento', 'codigoDocumento')),
    fecha: str(pick(o, 'fecha', 'fechaDocumento', 'fechaRegistro')),
    url: str(pick(o, 'url', 'urlDocumento', 'enlace', 'link')),
  };
}

const list = (v: unknown): Obj[] => (Array.isArray(v) ? (v.filter((x) => x && typeof x === 'object') as Obj[]) : []);

export function parseResponse(data: unknown): SuperciasResult {
  const o = unwrap(data);
  const empty: SuperciasResult = { generales: [], juridicos: [], economicos: [] };
  if (!o) return empty;

  const cia = (pick(o, 'compania', 'compañia', 'empresa') as Obj | undefined) ?? o;
  const docs = (pick(o, 'documentos') as Obj | undefined) ?? o;

  let generales = list(pick(docs, 'generales', 'documentosGenerales')).map(toDoc);
  let juridicos = list(pick(docs, 'juridicos', 'jurídicos', 'documentosJuridicos')).map(toDoc);
  let economicos = list(pick(docs, 'economicos', 'económicos', 'documentosEconomicos')).map(toDoc);

  // alternativa: lista plana con un campo "tipo"/"categoria"
  if (!generales.length && !juridicos.length && !economicos.length && Array.isArray(docs)) {
    for (const d of list(docs)) {
      const t = String(pick(d, 'tipo', 'categoria', 'tipoDocumento') ?? '').toUpperCase();
      (t.startsWith('JUR') ? juridicos : t.startsWith('ECO') ? economicos : generales).push(toDoc(d));
    }
  }

  const byDate = (a: Documento, b: Documento) => (b.fecha ?? '').localeCompare(a.fecha ?? '');
  generales = generales.sort(byDate);
  juridicos = juridicos.sort(byDate);
  economicos = economicos.sort(byDate);

  return {
    compania: {
      nombre: str(pick(cia, 'nombre', 'razonSocial', 'denominacion')),
      expediente: str(pick(cia, 'expediente', 'numeroExpediente')),
      ruc: str(pick(cia, 'ruc', 'numeroRuc')),
      situacionLegal: str(pick(cia, 'situacionLegal', 'estado', 'situacion')),
      tipo: str(pick(cia, 'tipo', 'tipoCompania')),
      fechaConstitucion: str(pick(cia, 'fechaConstitucion')),
      capitalSuscrito: str(pick(cia, 'capitalSuscrito', 'capital')),
    },
    generales,
    juridicos,
    economicos,
    mensaje: str(pick(o, 'mensaje', 'message', 'error')),
  };
}

/* ───────── consulta ───────── */

async function consultar(q: Query): Promise<SuperciasResult> {
  const c = config()!;
  return cached(`supercias:${q.kind}:${q.value}`, 6 * 60 * 60_000, async () => {
    const { url, init } = buildRequest(c, q);
    const t0 = Date.now();
    const res = await fetchT(url, init, c.timeoutMs);
    const body = await res.json().catch(() => null);
    await audit(c, { criterio: q.value, tipo: q.kind, ip: q.ip, http: res.status, ms: Date.now() - t0 });
    if (res.status === 401 || res.status === 403) throw new Error('Credenciales del convenio rechazadas (revisa SUPERCIAS_API_KEY).');
    if (res.status === 404) return { generales: [], juridicos: [], economicos: [] };
    if (!res.ok) throw new Error(`El servicio de la Supercias respondió ${res.status}.`);
    return parseResponse(body);
  });
}

const ver = (d: Documento): Link => (d.url && /^https:\/\//.test(d.url) ? { text: 'Ver ↗', href: d.url } : '—');

export const supercias: Source = {
  ...manual,
  async run(q) {
    if (!superciasConvenioActivo()) return manual.run(q);

    const r = await consultar(q);
    const total = r.generales.length + r.juridicos.length + r.economicos.length;
    if (!total && !r.compania?.nombre) {
      return { status: 'empty', summary: r.mensaje || 'La Supercias no tiene una compañía registrada con este criterio.' };
    }

    const tables: Table[] = [];
    if (r.generales.length)
      tables.push({
        title: `Documentos generales (${r.generales.length})`,
        columns: ['Expediente', 'Descripción', 'Fecha', 'Ver'],
        rows: r.generales.map((d) => [d.expediente ?? '—', d.descripcion ?? '—', fmtDate(d.fecha), ver(d)]),
      });
    if (r.juridicos.length)
      tables.push({
        title: `Documentos jurídicos (${r.juridicos.length})`,
        columns: ['Expediente', 'Resolución', 'Acto jurídico', 'Documento', 'Fecha', 'Ver'],
        rows: r.juridicos.map((d) => [d.expediente ?? '—', d.resolucion ?? '—', d.actoJuridico ?? '—', d.descripcion ?? '—', fmtDate(d.fecha), ver(d)]),
      });
    if (r.economicos.length)
      tables.push({
        title: `Documentos económicos (${r.economicos.length})`,
        columns: ['Expediente', 'Documento', 'Id', 'Fecha', 'Ver'],
        rows: r.economicos.map((d) => [d.expediente ?? '—', d.descripcion ?? '—', d.idDocumento ?? '—', fmtDate(d.fecha), ver(d)]),
      });

    const c = r.compania ?? {};
    return {
      status: 'ok',
      summary: `${c.nombre ?? 'Compañía'}${c.expediente ? ` · expediente ${c.expediente}` : ''} · ${total} documento(s).`,
      stats: [
        { label: 'Generales', value: String(r.generales.length) },
        { label: 'Jurídicos', value: String(r.juridicos.length) },
        { label: 'Económicos', value: String(r.economicos.length) },
      ],
      fields: [
        c.nombre && { label: 'Compañía', value: c.nombre },
        c.expediente && { label: 'Expediente', value: c.expediente },
        c.ruc && { label: 'RUC', value: c.ruc },
        c.tipo && { label: 'Tipo', value: c.tipo },
        c.situacionLegal && { label: 'Situación legal', value: c.situacionLegal },
        c.fechaConstitucion && { label: 'Constitución', value: fmtDate(c.fechaConstitucion) },
        c.capitalSuscrito && { label: 'Capital suscrito', value: c.capitalSuscrito },
      ].filter((x): x is { label: string; value: string } => !!x),
      tables,
      note: 'Consulta vía servicio web de convenio con la Superintendencia de Compañías, Valores y Seguros.',
    };
  },
};
