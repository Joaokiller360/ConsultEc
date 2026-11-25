export type Kind = 'cedula' | 'ruc' | 'nombre';
export type Mode = 'persona' | 'empresa';

/**
 * ok      → la fuente devolvió datos
 * empty   → la fuente respondió sin registros
 * manual  → la fuente exige verificación humana (captcha / aceptación de términos);
 *           se muestra enlace al sitio oficial
 * na      → la fuente no aplica a este tipo de búsqueda
 * error   → falló la consulta (timeout, cambio en la API, etc.)
 */
export type Status = 'ok' | 'empty' | 'manual' | 'na' | 'error';

export interface Field {
  label: string;
  value: string;
}

/** Celda: texto, enlace o foto (solo https). */
export type Cell = string | { text: string; href: string } | { img: string; alt?: string };

export interface Table {
  title?: string;
  columns: string[];
  rows: Cell[][];
}

export interface SourceResult {
  id: string;
  name: string;
  status: Status;
  summary?: string;
  fields?: Field[];
  tables?: Table[];
  stats?: Field[];
  officialUrl: string;
  note?: string;
  elapsedMs?: number;
}

export interface Query {
  raw: string;
  kind: Kind;
  mode: Mode;
  /** identificador limpio (solo dígitos) o nombre normalizado en mayúsculas */
  value: string;
  /** IP del cliente (solo para auditoría de fuentes con convenio) */
  ip?: string;
}

export interface Source {
  id: string;
  name: string;
  institution: string;
  officialUrl: string;
  /** tipos de búsqueda que la fuente soporta */
  supports: Kind[];
  run(q: Query): Promise<Omit<SourceResult, 'id' | 'name' | 'officialUrl'> & { officialUrl?: string }>;
}
