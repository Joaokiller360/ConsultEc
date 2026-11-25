#!/usr/bin/env node
/**
 * Importa los datos abiertos del Ranking Empresarial de la Superintendencia de Compañías
 * (https://appscvsmovil.supercias.gob.ec/ranking/reporte.html) a una base SQLite local.
 *
 *   npm run data:supercias                 # descarga + importa (últimos 6 años de estados financieros)
 *   npm run data:supercias -- --years 10   # más años
 *   npm run data:supercias -- --no-download  # reimporta con los CSV ya descargados
 *
 * Resultado: data/supercias.db  (los CSV quedan en data/supercias/)
 */
import { createReadStream, createWriteStream, existsSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { DatabaseSync } from 'node:sqlite';

const BASE = 'https://appscvsmovil.supercias.gob.ec/ranking/recursos';
const FILES = ['bi_compania.csv', 'bi_ranking.csv', 'bi_ciiu.csv', 'bi_segmento.csv'];
const DIR = 'data/supercias';
const DB = 'data/supercias.db';

const args = process.argv.slice(2);
const YEARS = Number(args[args.indexOf('--years') + 1]) || 6;
const DOWNLOAD = !args.includes('--no-download');
const MIN_YEAR = new Date().getFullYear() - YEARS;

const t0 = Date.now();
const log = (...m) => console.log(`[${((Date.now() - t0) / 1000).toFixed(1)}s]`, ...m);

/* ───────── descarga ───────── */
async function download(file) {
  const res = await fetch(`${BASE}/${file}`, { headers: { 'User-Agent': 'ConsultaEC/1.0 (datos abiertos)' } });
  if (!res.ok) throw new Error(`${file}: HTTP ${res.status}`);
  const tmp = `${DIR}/${file}.part`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
  renameSync(tmp, `${DIR}/${file}`);
  log(`descargado ${file} (${(statSync(`${DIR}/${file}`).size / 1e6).toFixed(1)} MB)`);
  return res.headers.get('last-modified') ?? '';
}

/* ───────── CSV (comillas, comas y saltos dentro de comillas) ───────── */
function parseLine(line) {
  const out = [];
  let cur = '';
  let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) {
      if (ch === '"') {
        if (line[i + 1] === '"') (cur += '"'), i++;
        else q = false;
      } else cur += ch;
    } else if (ch === '"') q = true;
    else if (ch === ',') out.push(cur.trim()), (cur = '');
    else cur += ch;
  }
  out.push(cur.trim());
  return out;
}

async function* rows(file) {
  const rl = createInterface({ input: createReadStream(`${DIR}/${file}`, 'utf8'), crlfDelay: Infinity });
  let header = null;
  let buf = '';
  for await (let line of rl) {
    buf = buf ? `${buf}\n${line}` : line;
    if ((buf.match(/"/g)?.length ?? 0) % 2) continue; // comilla abierta: registro multilínea
    line = buf.replace(/^﻿/, '');
    buf = '';
    if (!line.trim()) continue;
    const cells = parseLine(line);
    if (!header) {
      header = cells.map((h) => h.toLowerCase());
      continue;
    }
    const o = {};
    header.forEach((h, i) => (o[h] = cells[i] ?? ''));
    yield o;
  }
}

export const norm = (s) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9Ñ ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const num = (v) => (v === '' || v == null || Number.isNaN(Number(v)) ? null : Number(v));

/* ───────── importación ───────── */
async function main() {
  mkdirSync(DIR, { recursive: true });
  const modified = {};
  if (DOWNLOAD) {
    log('descargando datos abiertos de la Supercias…');
    for (const f of FILES) modified[f] = await download(f);
  } else {
    for (const f of FILES) if (!existsSync(`${DIR}/${f}`)) throw new Error(`Falta ${DIR}/${f}; ejecuta sin --no-download`);
  }

  const tmpDb = `${DB}.tmp`;
  rmSync(tmpDb, { force: true });
  const db = new DatabaseSync(tmpDb);
  db.exec(`
    PRAGMA journal_mode = OFF; PRAGMA synchronous = OFF;
    CREATE TABLE companias (expediente INTEGER PRIMARY KEY, ruc TEXT, nombre TEXT, nombre_norm TEXT, tipo TEXT, provincia TEXT);
    CREATE TABLE ranking (
      expediente INTEGER, anio INTEGER, posicion INTEGER,
      ingresos_ventas REAL, ingresos_totales REAL, activos REAL, patrimonio REAL, deuda_total REAL,
      utilidad_an_imp REAL, impuesto_renta REAL, utilidad_neta REAL, n_empleados REAL,
      cod_segmento INTEGER, ciiu_n1 TEXT, ciiu_n6 TEXT,
      liquidez_corriente REAL, end_activo REAL, margen_bruto REAL, roe REAL, roa REAL,
      PRIMARY KEY (expediente, anio));
    CREATE TABLE ciiu (ciiu TEXT PRIMARY KEY, descripcion TEXT);
    CREATE TABLE segmento (id INTEGER PRIMARY KEY, segmento TEXT);
    CREATE TABLE meta (k TEXT PRIMARY KEY, v TEXT);
  `);

  const batch = async (file, sql, map) => {
    const st = db.prepare(sql);
    let n = 0;
    db.exec('BEGIN');
    for await (const r of rows(file)) {
      const vals = map(r);
      if (!vals) continue;
      st.run(...vals);
      if (++n % 50_000 === 0) {
        db.exec('COMMIT; BEGIN');
        process.stdout.write(`\r  ${file}: ${n.toLocaleString('es-EC')} filas`);
      }
    }
    db.exec('COMMIT');
    process.stdout.write(`\r  ${file}: ${n.toLocaleString('es-EC')} filas\n`);
    return n;
  };

  log('importando compañías…');
  await batch('bi_compania.csv', 'INSERT OR REPLACE INTO companias VALUES (?,?,?,?,?,?)', (r) =>
    r.expediente ? [Number(r.expediente), r.ruc || null, r.nombre, norm(r.nombre), r.tipo, r.provincia] : null,
  );

  log(`importando estados financieros desde ${MIN_YEAR + 1}…`);
  await batch(
    'bi_ranking.csv',
    'INSERT OR REPLACE INTO ranking VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)',
    (r) => {
      const anio = Number(r.anio);
      if (!anio || anio <= MIN_YEAR || !r.expediente) return null;
      return [
        Number(r.expediente), anio, num(r.posicion_general),
        num(r.ingresos_ventas), num(r.ingresos_totales), num(r.activos), num(r.patrimonio), num(r.deuda_total),
        num(r.utilidad_an_imp), num(r.impuesto_renta), num(r.utilidad_neta), num(r.n_empleados),
        num(r.cod_segmento), r.ciiu_n1 || null, r.ciiu_n6 || null,
        num(r.liquidez_corriente), num(r.end_activo), num(r.margen_bruto), num(r.roe), num(r.roa),
      ];
    },
  );

  await batch('bi_ciiu.csv', 'INSERT OR REPLACE INTO ciiu VALUES (?,?)', (r) => (r.ciiu ? [r.ciiu, r.descripcion] : null));
  await batch('bi_segmento.csv', 'INSERT OR REPLACE INTO segmento VALUES (?,?)', (r) =>
    r.id_segmento ? [Number(r.id_segmento), r.segmento] : null,
  );

  log('creando índices…');
  db.exec(`
    CREATE INDEX idx_cia_ruc ON companias(ruc);
    CREATE INDEX idx_cia_norm ON companias(nombre_norm);
  `);
  const ins = db.prepare('INSERT OR REPLACE INTO meta VALUES (?,?)');
  ins.run('importado', new Date().toISOString());
  ins.run('anios', String(YEARS));
  ins.run('fuente', BASE);
  ins.run('modificado', modified['bi_compania.csv'] || '');
  db.exec('VACUUM');
  db.close();
  renameSync(tmpDb, DB);
  log(`listo → ${DB} (${(statSync(DB).size / 1e6).toFixed(1)} MB)`);
}

main().catch((e) => {
  console.error('\n✗', e.message);
  process.exit(1);
});
