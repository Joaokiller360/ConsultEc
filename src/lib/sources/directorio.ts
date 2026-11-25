import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { money } from '../http';
import type { Query, Source, Table } from '../types';

/**
 * Directorio de compañías + estados financieros (Ranking Empresarial) de la Superintendencia de
 * Compañías, desde sus DATOS ABIERTOS importados localmente con `npm run data:supercias`.
 */

const DB_PATH = process.env.SUPERCIAS_DB || 'data/supercias.db';
const RANKING_URL = 'https://appscvsmovil.supercias.gob.ec/ranking/reporte.html';

type Row = Record<string, any>;
interface Db {
  prepare(sql: string): { get(...a: unknown[]): Row | undefined; all(...a: unknown[]): Row[] };
}

let db: Db | null = null;
function open(): Db | null {
  if (db) return db;
  if (!existsSync(DB_PATH)) return null;
  // createRequire: evita que Vite intente empaquetar el módulo nativo node:sqlite
  const { DatabaseSync } = createRequire(import.meta.url)('node:sqlite');
  db = new DatabaseSync(DB_PATH, { readOnly: true }) as Db;
  return db;
}

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9Ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

// formas societarias que no ayudan a distinguir compañías
const STOP = new Set(['S', 'A', 'SA', 'SAS', 'CA', 'C', 'CIA', 'LTDA', 'EP', 'DE', 'DEL', 'LA', 'LAS', 'LOS', 'EL', 'Y', 'COMPANIA', 'SOCIEDAD', 'ANONIMA', 'LIMITADA']);

function search(d: Db, q: Query): Row[] {
  if (q.kind === 'ruc') return d.prepare('SELECT * FROM companias WHERE ruc = ?').all(q.value);
  const n = norm(q.value);
  const tokens = n.split(' ').filter((t) => t.length > 1 && !STOP.has(t)).slice(0, 6);
  if (!tokens.length) return [];
  const where = tokens.map(() => 'nombre_norm LIKE ?').join(' AND ');
  return d
    .prepare(`SELECT * FROM companias WHERE ${where} ORDER BY (nombre_norm = ?) DESC, length(nombre) LIMIT 25`)
    .all(...tokens.map((t) => `%${t}%`), n);
}

const fmtN = (v: number | null | undefined) => (v == null ? '—' : new Intl.NumberFormat('es-EC').format(Math.round(v)));
const fmtM = (v: number | null | undefined) => (v == null ? '—' : money(v));
const pct = (v: number | null | undefined) => (v == null ? '—' : `${(v * 100).toFixed(1)} %`);

function detail(d: Db, c: Row) {
  const fin = d.prepare('SELECT * FROM ranking WHERE expediente = ? ORDER BY anio DESC').all(c.expediente);
  const last = fin[0];
  const ciiu = last?.ciiu_n6 ? d.prepare('SELECT descripcion FROM ciiu WHERE ciiu = ?').get(last.ciiu_n6) : undefined;
  const seg = last?.cod_segmento != null ? d.prepare('SELECT segmento FROM segmento WHERE id = ?').get(last.cod_segmento) : undefined;

  const tables: Table[] = fin.length
    ? [
        {
          title: `Estados financieros (${fin.length} años)`,
          columns: ['Año', 'Posición', 'Ingresos por ventas', 'Activos', 'Patrimonio', 'Utilidad neta', 'Empleados', 'ROE'],
          rows: fin.map((r) => [
            String(r.anio),
            r.posicion ? `#${fmtN(r.posicion)}` : '—',
            fmtM(r.ingresos_ventas),
            fmtM(r.activos),
            fmtM(r.patrimonio),
            fmtM(r.utilidad_neta),
            fmtN(r.n_empleados),
            pct(r.roe),
          ]),
        },
      ]
    : [];

  return {
    status: 'ok' as const,
    summary: `${c.nombre} · expediente ${c.expediente}${last ? ` · posición #${fmtN(last.posicion)} en ${last.anio}` : ''}`,
    stats: last
      ? [
          { label: `Ingresos ${last.anio}`, value: fmtM(last.ingresos_ventas) },
          { label: 'Activos', value: fmtM(last.activos) },
          { label: 'Utilidad neta', value: fmtM(last.utilidad_neta) },
          { label: 'Empleados', value: fmtN(last.n_empleados) },
        ]
      : undefined,
    fields: [
      { label: 'Expediente', value: String(c.expediente) },
      { label: 'RUC', value: c.ruc ?? '—' },
      { label: 'Razón social', value: c.nombre },
      { label: 'Tipo de compañía', value: c.tipo || '—' },
      { label: 'Provincia', value: c.provincia || '—' },
      seg && { label: 'Tamaño', value: seg.segmento },
      last?.ciiu_n6 && { label: 'Actividad (CIIU)', value: `${last.ciiu_n6}${ciiu ? ` · ${ciiu.descripcion}` : ''}` },
    ].filter(Boolean) as { label: string; value: string }[],
    tables,
    note: fin.length
      ? 'Fuente: datos abiertos del Ranking Empresarial de la Supercias (estados financieros presentados por la compañía).'
      : 'La compañía consta en el directorio pero no tiene estados financieros en el período importado.',
  };
}

export const directorio: Source = {
  id: 'cias',
  name: 'Directorio y estados financieros',
  institution: 'Superintendencia de Compañías · datos abiertos',
  officialUrl: RANKING_URL,
  supports: ['ruc', 'nombre'],
  async run(q) {
    const d = open();
    if (!d) {
      return {
        status: 'na',
        summary: 'Los datos abiertos de la Supercias no están importados en este servidor.',
        note: 'Ejecuta `npm run data:supercias` para descargarlos (~430 MB) e importarlos.',
      };
    }
    const found = search(d, q);
    if (!found.length) {
      return {
        status: 'empty',
        summary:
          q.kind === 'ruc'
            ? 'Este RUC no consta en el directorio de compañías de la Supercias (empresas públicas, personas naturales y otras entidades no están bajo su control).'
            : 'Ninguna compañía coincide con ese nombre.',
      };
    }
    const exact = found.find((c) => norm(c.nombre) === norm(q.value));
    if (found.length === 1 || exact) return detail(d, exact ?? found[0]);

    return {
      status: 'ok',
      summary: `${found.length >= 25 ? 'Más de 25' : found.length} compañías coinciden. Elige una para ver su detalle.`,
      tables: [
        {
          title: 'Coincidencias',
          columns: ['Razón social', 'RUC', 'Expediente', 'Tipo', 'Provincia'],
          rows: found.map((c) => [
            c.ruc ? { text: c.nombre, href: `/?q=${c.ruc}&m=empresa` } : c.nombre,
            c.ruc ?? '—',
            String(c.expediente),
            c.tipo || '—',
            c.provincia || '—',
          ]),
        },
      ],
    };
  },
};
