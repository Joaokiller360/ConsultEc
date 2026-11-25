import { cached, fetchT, fmtDate } from '../http';
import type { Source, Table } from '../types';

/**
 * Consulta de causas (E-SATJE / Función Judicial).
 * La API pública puede exigir un token reCAPTCHA emitido al navegador del usuario.
 * No lo evadimos: si la API rechaza la consulta, la tarjeta pasa a modo "manual"
 * con enlace al sitio oficial.
 */
const API =
  'https://api.funcionjudicial.gob.ec/EXPEL-CONSULTA-CAUSAS-SERVICE/api/consulta-causas/informacion/buscarCausas';

type Causa = Record<string, unknown>;

class NeedsHuman extends Error {}

async function buscar(role: 'actor' | 'demandado', q: { kind: string; value: string }): Promise<Causa[]> {
  const isId = q.kind !== 'nombre';
  const body = {
    numeroCausa: '',
    actor: {
      cedulaActor: role === 'actor' && isId ? q.value : '',
      nombreActor: role === 'actor' && !isId ? q.value : '',
    },
    demandado: {
      cedulaDemandado: role === 'demandado' && isId ? q.value : '',
      nombreDemandado: role === 'demandado' && !isId ? q.value : '',
    },
    provincia: '',
    numeroFiscalia: '',
    first: 1,
    pageSize: 50,
  };
  return cached(`fj:${role}:${q.value}`, 30 * 60_000, async () => {
    const res = await fetchT(`${API}?page=1&size=50`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Origin: 'https://procesosjudiciales.funcionjudicial.gob.ec' },
      body: JSON.stringify(body),
    });
    if (res.status === 400 || res.status === 401 || res.status === 403 || res.status === 429) {
      throw new NeedsHuman(`HTTP ${res.status}`);
    }
    if (!res.ok) throw new Error(`Función Judicial respondió ${res.status}`);
    const data = await res.json().catch(() => null);
    if (!Array.isArray(data)) throw new NeedsHuman('respuesta inesperada');
    return data as Causa[];
  });
}

const pick = (o: Causa, ...keys: string[]) => {
  for (const k of keys) {
    const v = o[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return '—';
};

const toTable = (title: string, causas: Causa[]): Table => ({
  title,
  columns: ['N.º de causa', 'Fecha de ingreso', 'Acción / delito', 'Judicatura', 'Estado'],
  rows: causas.map((c) => {
    const id = pick(c, 'idJuicio', 'numeroCausa');
    return [
      id === '—'
        ? id
        : { text: id, href: `https://procesosjudiciales.funcionjudicial.gob.ec/expel-busqueda-avanzada?numeroCausa=${encodeURIComponent(id)}` },
      fmtDate(pick(c, 'fechaIngreso', 'fecha')),
      pick(c, 'nombreDelito', 'nombreAccion', 'delito'),
      pick(c, 'nombreJudicatura', 'judicatura', 'idJudicatura'),
      pick(c, 'nombreEstadoJuicio', 'estadoActual', 'estado'),
    ];
  }),
});

export const judicial: Source = {
  id: 'judicial',
  name: 'Procesos judiciales',
  institution: 'Consejo de la Judicatura · Función Judicial',
  officialUrl: 'https://consultas.funcionjudicial.gob.ec/informacionjudicialindividual/pages/index.jsf#!/',
  supports: ['cedula', 'ruc', 'nombre'],
  async run(q) {
    try {
      const [dem, act] = await Promise.all([buscar('demandado', q), buscar('actor', q)]);
      if (!dem.length && !act.length) {
        return { status: 'empty', summary: 'Sin causas judiciales como actor ni como demandado.' };
      }
      return {
        status: 'ok',
        summary: `${dem.length + act.length} causa(s) encontradas.`,
        stats: [
          { label: 'Como demandado / procesado', value: String(dem.length) },
          { label: 'Como actor / ofendido', value: String(act.length) },
        ],
        tables: [
          ...(dem.length ? [toTable('Como demandado / procesado', dem)] : []),
          ...(act.length ? [toTable('Como actor / ofendido', act)] : []),
        ],
        note: 'Se muestran hasta 50 causas por rol. Ser parte de una causa no implica responsabilidad.',
      };
    } catch (e) {
      if (e instanceof NeedsHuman) {
        return {
          status: 'manual',
          summary: 'La Función Judicial exige verificación (captcha) en su portal para esta consulta.',
          note: 'Abre el portal oficial y pega el identificador copiado.',
        };
      }
      throw e;
    }
  },
};
