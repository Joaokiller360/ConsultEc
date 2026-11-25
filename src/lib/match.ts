/**
 * Coincidencia de nombres compartida por servidor y navegador (Policía Nacional, INTERPOL).
 * Sin tildes, en mayúsculas, sin partículas; tolera una letra de diferencia (WILLIAN ~ WILLIAM).
 */
export const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, ' ')
    .trim();

const STOP = new Set(['DE', 'DEL', 'LA', 'LAS', 'LOS', 'Y']);
export const nameTokens = (s: string) => norm(s).split(' ').filter((t) => t.length > 1 && !STOP.has(t));

/** Distancia de edición ≤ 1 en palabras de 5+ letras. */
export function near(a: string, b: string) {
  if (a === b) return true;
  if (Math.min(a.length, b.length) < 5 || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  let j = 0;
  let diff = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      i++;
      j++;
      continue;
    }
    if (++diff > 1) return false;
    if (a.length > b.length) i++;
    else if (b.length > a.length) j++;
    else {
      i++;
      j++;
    }
  }
  return diff + (a.length - i) + (b.length - j) <= 1;
}

export type MatchLevel = 'Exacta' | 'Probable' | 'Parcial';

/**
 * Coinciden si todas las palabras de la búsqueda están en el nombre listado, o todas las del nombre
 * listado en la búsqueda, con al menos 2 palabras en común (el orden no importa).
 * Exacta = mismas palabras; Probable = mismas palabras con una letra distinta; Parcial = subconjunto.
 */
export function matchLevel(query: string[], candidate: string[]): MatchLevel | null {
  if (query.length < 2) return null;
  let matched = 0;
  let fuzzy = false;
  const used = new Set<number>();
  for (const t of query) {
    const k = candidate.findIndex((r, idx) => !used.has(idx) && r === t);
    const f = k >= 0 ? k : candidate.findIndex((r, idx) => !used.has(idx) && near(r, t));
    if (f >= 0) {
      used.add(f);
      matched++;
      if (k < 0) fuzzy = true;
    }
  }
  if (matched < 2 || (matched < query.length && matched < candidate.length)) return null;
  const full = matched === query.length && matched === candidate.length;
  return full && !fuzzy ? 'Exacta' : full ? 'Probable' : 'Parcial';
}

export const LEVEL_RANK: Record<MatchLevel, number> = { Exacta: 0, Probable: 1, Parcial: 2 };

// Formas societarias y palabras genéricas que no distinguen a una entidad
const ORG_STOP = new Set([
  'SA', 'S', 'A', 'SAS', 'CA', 'C', 'CIA', 'LTDA', 'EP', 'BP', 'CO', 'INC', 'LLC', 'COMPANIA', 'SOCIEDAD', 'ANONIMA', 'LIMITADA',
  'POR', 'ACCIONES', 'SIMPLIFICADA', 'EC', 'ECUADOR',
]);
export const orgTokens = (s: string) => nameTokens(s).filter((t) => !ORG_STOP.has(t));

/**
 * Coincidencia de nombres de entidades (marcas, razones sociales). Acepta nombres de una sola palabra
 * solo si son idénticos, y compara también sin espacios (DINEROFACIL = DINERO FACIL).
 */
export function matchEntity(query: string[], candidate: string[]): MatchLevel | null {
  if (!query.length || !candidate.length) return null;
  if (query.join('') === candidate.join('')) return 'Exacta';
  if (query.length === 1 || candidate.length === 1) return null;
  return matchLevel(query, candidate);
}
