import { audit, buildJsonRequest, loadConvenio, pick, str, unwrap, type ConvenioConfig } from '../convenio';
import { fetchT, fmtDate } from '../http';
import type { Query, Source } from '../types';
import { antecedentes as manual } from './manual';

/**
 * Antecedentes penales vía servicio web de CONVENIO (DINARDAP / Ministerio del Interior).
 *
 * Solo se activa con MDI_API_URL y MDI_API_KEY (y MDI_MOTIVO, obligatorio). Sin ellas la tarjeta
 * funciona en modo manual (portal oficial + lectura local del PDF).
 *
 * ⚙ Con la especificación oficial, ajusta SOLO `buildRequest()` y `parseResponse()`.
 */

const config = () => loadConvenio('MDI_', { auditLog: 'logs/auditoria-antecedentes.jsonl' });
export const convenioActivo = () => config() !== null;

/* ───────── adaptar a la especificación oficial ───────── */

function buildRequest(c: ConvenioConfig, cedula: string, motivo: string) {
  return buildJsonRequest(c, { identificacion: cedula, tipoIdentificacion: 'C', motivo });
}

export interface ConvenioResult {
  nombre?: string;
  antecedentes?: 'SI' | 'NO';
  numeroCertificado?: string;
  fecha?: string;
  mensaje?: string;
}

export function parseResponse(data: unknown): ConvenioResult {
  const o = unwrap(data);
  if (!o) return {};
  const raw = pick(o, 'poseeAntecedentes', 'antecedentes', 'tieneAntecedentes', 'registraAntecedentes', 'antecedente');
  let antecedentes: ConvenioResult['antecedentes'];
  if (typeof raw === 'boolean') antecedentes = raw ? 'SI' : 'NO';
  else if (typeof raw === 'string') {
    const v = raw.trim().toUpperCase();
    if (/^(S|SI|SÍ|TRUE|1)$/.test(v)) antecedentes = 'SI';
    else if (/^(N|NO|FALSE|0)$/.test(v) || /NO\s+(REGISTRA|POSEE)/.test(v)) antecedentes = 'NO';
  }
  return {
    antecedentes,
    nombre: str(pick(o, 'nombre', 'nombres', 'nombreCompleto', 'apellidosNombres')),
    numeroCertificado: str(pick(o, 'numeroCertificado', 'certificado', 'codigo', 'idCertificado')),
    fecha: str(pick(o, 'fecha', 'fechaEmision', 'fechaConsulta')),
    mensaje: str(pick(o, 'mensaje', 'message', 'error', 'observacion')),
  };
}

/* ───────── consulta ───────── */

export async function consultarConvenio(q: Query, meta: { ip?: string } = {}) {
  const c = config()!;
  const motivo = c.extra.MOTIVO;
  if (!motivo) throw new Error('Falta MDI_MOTIVO: el convenio exige declarar el motivo de cada consulta.');

  const { url, init } = buildRequest(c, q.value, motivo);
  const t0 = Date.now();
  const res = await fetchT(url, init, c.timeoutMs);
  const body = await res.json().catch(() => null);
  await audit(c, { cedula: q.value, motivo, ip: meta.ip, http: res.status, ms: Date.now() - t0 });

  if (res.status === 401 || res.status === 403) throw new Error('Credenciales del convenio rechazadas (revisa MDI_API_KEY).');
  if (!res.ok) throw new Error(`El servicio del convenio respondió ${res.status}.`);
  return parseResponse(body);
}

export const antecedentes: Source = {
  ...manual,
  async run(q) {
    if (!convenioActivo()) return manual.run(q);

    const r = await consultarConvenio(q, { ip: q.ip });
    if (!r.antecedentes) {
      return { status: 'error', summary: r.mensaje || 'El servicio del convenio no devolvió el estado de antecedentes.' };
    }
    return {
      status: 'ok',
      summary: r.antecedentes === 'NO' ? 'No registra antecedentes penales.' : 'Registra antecedentes penales.',
      stats: [{ label: 'Posee antecedentes', value: r.antecedentes === 'SI' ? 'SÍ' : 'NO' }],
      fields: [
        r.nombre && { label: 'Nombre', value: r.nombre },
        { label: 'Cédula', value: q.value },
        r.numeroCertificado && { label: 'N.º de certificado', value: r.numeroCertificado },
        r.fecha && { label: 'Fecha', value: fmtDate(r.fecha) },
      ].filter((x): x is { label: string; value: string } => !!x),
      note: 'Consulta vía servicio web de convenio. Registrada en la auditoría de la institución.',
    };
  },
};
