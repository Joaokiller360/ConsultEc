import { cached, fetchT, fmtDate, money } from '../http';
import type { Source, Table } from '../types';
import { sriLookup } from './sri';

export const SERCOP_API = 'https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA/api';
const YEARS_BACK = 5;

interface OcdsHit {
  id: number;
  ocid: string;
  year: number;
  month: number;
  method: string;
  internal_type: string;
  locality: string;
  region: string;
  suppliers: string;
  buyer: string;
  amount: string;
  date: string;
  title: string;
  description: string;
  budget: string;
}

interface OcdsPage {
  total: number;
  page: number;
  pages: number;
  data: OcdsHit[];
}

async function search(role: 'supplier' | 'buyer', name: string, year: number): Promise<OcdsPage> {
  return cached(`sercop:${role}:${year}:${name}`, 60 * 60_000, async () => {
    const url = `${SERCOP_API}/search_ocds?year=${year}&${role}=${encodeURIComponent(name)}&page=1`;
    const res = await limit(() => fetchT(url, {}, 30000));
    if (!res.ok) throw new Error(`SERCOP respondió ${res.status}`);
    return (await res.json()) as OcdsPage;
  });
}

/** El portal de SERCOP es lento y se satura con muchas peticiones simultáneas. */
const MAX_CONCURRENT = 4;
let active = 0;
const waiting: (() => void)[] = [];
async function limit<T>(fn: () => Promise<T>): Promise<T> {
  if (active >= MAX_CONCURRENT) await new Promise<void>((r) => waiting.push(r));
  active++;
  try {
    return await fn();
  } finally {
    active--;
    waiting.shift()?.();
  }
}

/**
 * SERCOP registra los nombres sin sufijos que sí usa el SRI
 * (p. ej. "CORPORACION NACIONAL DE TELECOMUNICACIONES - CNT EP").
 */
export function nameVariants(n: string): string[] {
  const base = n.split(' - ')[0].trim();
  const stripped = base
    .replace(/\b(S\.?\s?A\.?\s?S\.?|S\.?\s?A\.?|C\.?\s?A\.?|CIA\.?\s*LTDA\.?|COMPA[ÑN][IÍ]A LIMITADA|SOCIEDAD AN[OÓ]NIMA|E\.?\s?P\.?)$/i, '')
    .replace(/[\s.,-]+$/, '')
    .trim();
  return [...new Set([base, stripped, n])].filter((v) => v.length >= 4);
}

type YearsResult = Awaited<ReturnType<typeof searchAllYears>> & { matched: string };

async function searchBestVariant(role: 'supplier' | 'buyer', variants: string[]): Promise<YearsResult> {
  let last: YearsResult | null = null;
  for (const v of variants) {
    last = { ...(await searchAllYears(role, v)), matched: v };
    if (last.total > 0) break;
  }
  return last!;
}

async function searchAllYears(role: 'supplier' | 'buyer', name: string) {
  const now = new Date().getFullYear();
  const years = Array.from({ length: YEARS_BACK }, (_, i) => now - i);
  const pages = await Promise.allSettled(years.map((y) => search(role, name, y)));
  let total = 0;
  let failed = 0;
  const hits: OcdsHit[] = [];
  const perYear: { year: number; total: number }[] = [];
  pages.forEach((p, i) => {
    if (p.status === 'fulfilled') {
      total += p.value.total;
      hits.push(...p.value.data);
      perYear.push({ year: years[i], total: p.value.total });
    } else failed++;
  });
  hits.sort((a, b) => b.date.localeCompare(a.date));
  return { total, hits, failed, perYear, years };
}

const toRow = (h: OcdsHit, counterpart: string) => [
  fmtDate(h.date),
  { text: h.title || h.ocid, href: `/contrato/${encodeURIComponent(h.ocid)}` },
  counterpart,
  h.internal_type,
  money(Number(h.amount || h.budget || 0)),
];

export const sercop: Source = {
  id: 'sercop',
  name: 'Contratación pública',
  institution: 'SERCOP',
  officialUrl: 'https://datosabiertos.compraspublicas.gob.ec/PLATAFORMA/',
  supports: ['cedula', 'ruc', 'nombre'],
  async run(q) {
    let name = q.kind === 'nombre' ? q.value : null;
    if (!name) {
      const c = await sriLookup(q.value).catch(() => null);
      name = c?.razonSocial ?? null;
    }
    if (!name) {
      return {
        status: 'empty',
        summary: 'No se pudo resolver el nombre a partir del identificador.',
        note: 'SERCOP solo permite buscar por nombre. Prueba buscando por "APELLIDOS NOMBRES" o razón social.',
      };
    }

    const variants = nameVariants(name);
    const asBuyer = q.mode === 'empresa' || q.kind === 'ruc';
    const [sup, buy] = await Promise.all([
      searchBestVariant('supplier', variants),
      asBuyer ? searchBestVariant('buyer', variants) : Promise.resolve(null),
    ]);

    if (sup.failed === sup.years.length && (!buy || buy.failed === buy.years.length)) {
      throw new Error('El portal de datos abiertos de SERCOP no respondió a tiempo.');
    }

    const total = sup.total + (buy?.total ?? 0);
    const range = `${sup.years.at(-1)}–${sup.years[0]}`;
    const partial = sup.failed + (buy?.failed ?? 0);
    const partialNote = partial ? ` ${partial} consulta(s) por año no respondieron: los totales pueden ser mayores.` : '';
    if (!total) {
      return {
        status: 'empty',
        summary: `Sin procesos de contratación pública para "${name}" (${range}).`,
        note: partialNote.trim() || undefined,
      };
    }
    name = (sup.total ? sup.matched : buy?.matched) ?? name;

    const sum = (h: OcdsHit[]) => h.reduce((a, x) => a + Number(x.amount || 0), 0);
    const tables: Table[] = [];
    const cols = ['Fecha', 'Proceso', 'Contraparte', 'Tipo', 'Monto'];
    if (sup.hits.length)
      tables.push({
        title: `Como proveedor · ${sup.total} procesos`,
        columns: cols,
        rows: sup.hits.map((h) => toRow(h, h.buyer)),
      });
    if (buy?.hits.length)
      tables.push({
        title: `Como entidad contratante · ${buy.total} procesos`,
        columns: cols,
        rows: buy.hits.map((h) => toRow(h, h.suppliers)),
      });

    return {
      status: 'ok',
      summary: `${total} procesos encontrados para "${name}" (${range}).`,
      stats: [
        { label: 'Como proveedor', value: String(sup.total) },
        ...(buy ? [{ label: 'Como contratante', value: String(buy.total) }] : []),
        { label: 'Monto (muestra)', value: money(sum(sup.hits) + sum(buy?.hits ?? [])) },
        {
          label: 'Por año',
          value: sup.perYear
            .map((p) => `${p.year}: ${p.total + (buy?.perYear.find((b) => b.year === p.year)?.total ?? 0)}`)
            .join(' · '),
        },
      ],
      tables,
      note: `Se muestran los 10 procesos más recientes por año. El monto es la suma de la muestra, no del total. Coincidencia por nombre: puede incluir homónimos.${partialNote}`,
    };
  },
};
