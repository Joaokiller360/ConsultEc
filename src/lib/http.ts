const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36';

export async function fetchT(url: string, init: RequestInit = {}, ms = 15000): Promise<Response> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    return await fetch(url, {
      ...init,
      signal: ctrl.signal,
      headers: {
        'User-Agent': UA,
        Accept: 'application/json, text/html;q=0.9, */*;q=0.8',
        'Accept-Language': 'es-EC,es;q=0.9',
        ...(init.headers ?? {}),
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

/** Caché en memoria con TTL, para no golpear repetidamente las fuentes oficiales. */
const store = new Map<string, { exp: number; val: unknown }>();

export async function cached<T>(key: string, ttlMs: number, fn: () => Promise<T>): Promise<T> {
  const hit = store.get(key);
  if (hit && hit.exp > Date.now()) return hit.val as T;
  const val = await fn();
  store.set(key, { exp: Date.now() + ttlMs, val });
  if (store.size > 2000) {
    const now = Date.now();
    for (const [k, v] of store) if (v.exp < now) store.delete(k);
    // Tope duro: si todo sigue vigente, se descartan las entradas más antiguas (Map conserva el orden).
    for (const k of store.keys()) {
      if (store.size <= 2000) break;
      store.delete(k);
    }
  }
  return val;
}

export const money = (n: number) =>
  new Intl.NumberFormat('es-EC', { style: 'currency', currency: 'USD', maximumFractionDigits: 2 }).format(n);

export const fmtDate = (s?: string | null) => {
  if (!s) return '—';
  // "YYYY-MM-DD" sin hora se interpretaría como UTC (un día antes en Ecuador): forzar hora local
  const d = new Date(/^\d{4}-\d{2}-\d{2}$/.test(s) ? `${s}T00:00:00` : s.replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('es-EC', { year: 'numeric', month: 'short', day: '2-digit' });
};

/** Extrae tablas de un HTML simple → filas de texto plano. */
export function parseHtmlTables(html: string): string[][][] {
  const tables: string[][][] = [];
  const decode = (s: string) =>
    s
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&quot;/g, '"')
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
      .replace(/&([a-z]+)acute;/gi, (_, l) => ({ a: 'á', e: 'é', i: 'í', o: 'ó', u: 'ú', A: 'Á', E: 'É', I: 'Í', O: 'Ó', U: 'Ú' } as Record<string, string>)[l] ?? l)
      .replace(/&ntilde;/g, 'ñ')
      .replace(/&Ntilde;/g, 'Ñ')
      .replace(/\s+/g, ' ')
      .trim();
  for (const t of html.match(/<table[\s\S]*?<\/table>/gi) ?? []) {
    const rows: string[][] = [];
    for (const tr of t.match(/<tr[\s\S]*?<\/tr>/gi) ?? []) {
      const cells = (tr.match(/<t[hd][^>]*>[\s\S]*?<\/t[hd]>/gi) ?? []).map(decode);
      if (cells.some(Boolean)) rows.push(cells);
    }
    if (rows.length) tables.push(rows);
  }
  return tables;
}
