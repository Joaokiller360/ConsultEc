/**
 * Límite simple por IP (ventana deslizante de 1 minuto) para no abusar de las fuentes oficiales.
 * Compartido por /api/consulta/[fuente] y /contrato/[ocid].
 */
const WINDOW_MS = 60_000;
// Cada búsqueda de persona consulta ~9 fuentes → 40 req/min ≈ 4 búsquedas/min por IP.
const MAX_REQ = Math.max(1, Number(process.env.RATE_LIMIT_PER_MIN) || 40);
// Detrás de un proxy inverso (Caddy, Nginx) la IP real llega en X-Forwarded-For.
// Solo activar si la app NO es accesible directamente (si no, el encabezado se puede falsificar).
const TRUST_PROXY = process.env.TRUST_PROXY === '1' || process.env.TRUST_PROXY === 'true';
const hits = new Map<string, number[]>();

export function limited(ip: string) {
  const now = Date.now();
  const arr = (hits.get(ip) ?? []).filter((t) => now - t < WINDOW_MS);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 5000) {
    for (const [k, v] of hits) if (!v.length || now - v[v.length - 1] >= WINDOW_MS) hits.delete(k);
  }
  return arr.length > MAX_REQ;
}

/** Con un solo proxy de confianza, el último valor de X-Forwarded-For es el que añadió ese proxy. */
export function clientIp(request: Request, clientAddress: () => string) {
  if (TRUST_PROXY) {
    const xff = request.headers.get('x-forwarded-for');
    const last = xff?.split(',').map((s) => s.trim()).filter(Boolean).pop();
    if (last) return last;
  }
  try {
    return clientAddress();
  } catch {
    return 'local';
  }
}
