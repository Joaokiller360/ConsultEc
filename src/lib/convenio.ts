import { appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

/**
 * Utilidades comunes para fuentes que se consultan vía servicio web de CONVENIO
 * interinstitucional (credenciales en variables de entorno con un prefijo, p. ej. MDI_ o SUPERCIAS_).
 */

export interface ConvenioConfig {
  url: string;
  key: string;
  authHeader: string;
  authScheme: string;
  method: 'GET' | 'POST';
  auditLog?: string;
  timeoutMs: number;
  extra: Record<string, string | undefined>;
}

/** Devuelve null si faltan `${prefix}API_URL` o `${prefix}API_KEY` → la fuente queda en modo manual. */
export function loadConvenio(prefix: string, defaults: { auditLog?: string } = {}): ConvenioConfig | null {
  const env = process.env;
  const v = (k: string) => env[`${prefix}${k}`];
  if (!v('API_URL') || !v('API_KEY')) return null;
  return {
    url: v('API_URL')!,
    key: v('API_KEY')!,
    authHeader: v('API_AUTH_HEADER') || 'Authorization',
    authScheme: v('API_AUTH_SCHEME') ?? 'Bearer',
    method: v('API_METHOD') === 'GET' ? 'GET' : 'POST',
    auditLog: v('AUDIT_LOG') || defaults.auditLog,
    timeoutMs: Number(v('API_TIMEOUT_MS')) || 20000,
    extra: new Proxy({}, { get: (_, k: string) => v(k) }),
  };
}

export function authHeaders(c: ConvenioConfig): Record<string, string> {
  return { [c.authHeader]: c.authScheme ? `${c.authScheme} ${c.key}` : c.key, Accept: 'application/json' };
}

/** Construye GET (query string) o POST (JSON) según la configuración. */
export function buildJsonRequest(c: ConvenioConfig, params: Record<string, string>): { url: string; init: RequestInit } {
  if (c.method === 'GET') {
    const u = new URL(c.url);
    for (const [k, val] of Object.entries(params)) u.searchParams.set(k, val);
    return { url: u.toString(), init: { method: 'GET', headers: authHeaders(c) } };
  }
  return {
    url: c.url,
    init: {
      method: 'POST',
      headers: { ...authHeaders(c), 'Content-Type': 'application/json' },
      body: JSON.stringify(params),
    },
  };
}

export async function audit(c: ConvenioConfig, entry: Record<string, unknown>) {
  if (!c.auditLog) return;
  try {
    await mkdir(dirname(c.auditLog), { recursive: true });
    await appendFile(c.auditLog, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n');
  } catch (e) {
    console.error('[convenio] no se pudo escribir la auditoría', e);
  }
}

type Obj = Record<string, unknown>;

/** Desenvuelve respuestas tipo { data: {...} } / { resultado: {...} } / [ {...} ]. */
export function unwrap(data: unknown): Obj | undefined {
  const root = (Array.isArray(data) ? data[0] : data) as Obj | undefined;
  if (!root || typeof root !== 'object') return undefined;
  const inner = ['data', 'resultado', 'result', 'respuesta'].map((k) => root[k]).find((v) => v && typeof v === 'object' && !Array.isArray(v));
  return (inner ?? root) as Obj;
}

/** Primer valor no vacío entre varias claves posibles (sin distinguir mayúsculas). */
export function pick(o: Obj | undefined, ...keys: string[]): unknown {
  if (!o) return undefined;
  for (const k of keys) {
    const hit = Object.keys(o).find((x) => x.toLowerCase() === k.toLowerCase());
    if (hit && o[hit] !== null && o[hit] !== undefined && o[hit] !== '') return o[hit];
  }
  return undefined;
}

export const str = (v: unknown) => (v === undefined || v === null ? undefined : String(v));
