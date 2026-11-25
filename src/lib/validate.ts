import type { Kind } from './types';

const onlyDigits = (s: string) => s.replace(/\D/g, '');

function validProvince(p: number) {
  return (p >= 1 && p <= 24) || p === 30;
}

/** Valida cédula ecuatoriana (módulo 10). */
export function isCedula(c: string): boolean {
  if (!/^\d{10}$/.test(c)) return false;
  if (!validProvince(Number(c.slice(0, 2)))) return false;
  if (Number(c[2]) >= 6) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) {
    let v = Number(c[i]) * (i % 2 === 0 ? 2 : 1);
    if (v > 9) v -= 9;
    sum += v;
  }
  return (10 - (sum % 10)) % 10 === Number(c[9]);
}

/** Validación estructural de RUC (persona natural, sociedad privada o pública). */
export function isRuc(r: string): boolean {
  if (!/^\d{13}$/.test(r)) return false;
  if (!validProvince(Number(r.slice(0, 2)))) return false;
  if (r.endsWith('000')) return false;
  const d3 = Number(r[2]);
  if (d3 < 6) return isCedula(r.slice(0, 10));
  return d3 === 6 || d3 === 9;
}

/** Límites de entrada (se validan igual en el navegador y en el servidor). */
export const LIMITS = {
  rawMax: 150, // antes de cualquier proceso
  idRawMax: 20, // cédula/RUC con espacios, puntos o guiones
  persona: { minLen: 5, maxLen: 80, minWords: 2, maxWords: 6, maxWordLen: 25 },
  empresa: { minLen: 3, maxLen: 120, maxWords: 15, maxWordLen: 40 },
} as const;

// Persona: solo letras latinas (incluye tildes, ñ, ü), espacios, apóstrofo, guion y punto.
const PERSONA_RE = /^[\p{Script=Latin}\s'’.-]+$/u;
// Razón social: además dígitos y & , ( ) /
const EMPRESA_RE = /^[\p{Script=Latin}\p{Nd}\s'’.,&()/-]+$/u;
// Caracteres de control, de formato o invisibles (zero-width, bidi, etc.)
const INVISIBLE_RE = /[\p{Cc}\p{Cf}\p{Co}\p{Cn}]/u;

export function normalizeName(s: string) {
  return s.normalize('NFC').replace(/’/g, "'").replace(/\s+/g, ' ').trim().toUpperCase();
}

export type Detection =
  | { ok: true; kind: Kind; value: string }
  | { ok: false; reason: string };

export function detect(raw: string, mode: 'persona' | 'empresa' = 'persona'): Detection {
  if (raw.length > LIMITS.rawMax) return { ok: false, reason: `Texto demasiado largo (máximo ${LIMITS.rawMax} caracteres).` };
  const s = raw.normalize('NFC').trim();
  if (!s) return { ok: false, reason: 'Ingresa una cédula, RUC o nombre.' };
  if (INVISIBLE_RE.test(s.replace(/[\t\n\r]/g, ' '))) {
    return { ok: false, reason: 'El texto contiene caracteres no permitidos (invisibles o de control).' };
  }

  if (/^[\d\s.-]+$/.test(s)) {
    if (s.length > LIMITS.idRawMax) return { ok: false, reason: 'Una cédula tiene 10 dígitos y un RUC 13.' };
    const d = onlyDigits(s);
    if (d.length === 10) {
      return isCedula(d)
        ? { ok: true, kind: 'cedula', value: d }
        : { ok: false, reason: 'La cédula no es válida (dígito verificador).' };
    }
    if (d.length === 13) {
      return isRuc(d)
        ? { ok: true, kind: 'ruc', value: d }
        : { ok: false, reason: 'El RUC no tiene un formato válido.' };
    }
    return { ok: false, reason: 'Una cédula tiene 10 dígitos y un RUC 13.' };
  }

  const name = normalizeName(s);
  const words = name.split(' ');
  if (/(.)\1{4,}/u.test(name)) return { ok: false, reason: 'El texto repite demasiadas veces el mismo carácter.' };

  if (mode === 'persona') {
    const L = LIMITS.persona;
    if (!PERSONA_RE.test(name)) {
      return {
        ok: false,
        reason: /\d/.test(name)
          ? 'Escribe solo la cédula (números) o solo apellidos y nombres (letras), sin mezclar.'
          : 'Los nombres solo pueden tener letras, espacios, apóstrofo (\') y guion (-).',
      };
    }
    if (words.length < L.minWords || name.length < L.minLen) {
      return { ok: false, reason: 'Escribe al menos un nombre y un apellido.' };
    }
    if (words.length > L.maxWords) return { ok: false, reason: `Máximo ${L.maxWords} palabras (nombres y apellidos).` };
    if (name.length > L.maxLen) return { ok: false, reason: `Nombre demasiado largo (máximo ${L.maxLen} caracteres).` };
    if (words.some((w) => w.length > L.maxWordLen)) return { ok: false, reason: `Cada palabra puede tener hasta ${L.maxWordLen} letras.` };
    if (words.some((w) => !/\p{L}/u.test(w))) return { ok: false, reason: 'Cada palabra debe tener al menos una letra.' };
    return { ok: true, kind: 'nombre', value: name };
  }

  const L = LIMITS.empresa;
  if (!EMPRESA_RE.test(name)) {
    return { ok: false, reason: 'La razón social solo puede tener letras, números, espacios y . , & - \' ( ) /' };
  }
  if (name.length < L.minLen || (name.match(/\p{L}/gu)?.length ?? 0) < 2) {
    return { ok: false, reason: 'Escribe la razón social (al menos 2 letras).' };
  }
  if (words.length > L.maxWords) return { ok: false, reason: `Máximo ${L.maxWords} palabras.` };
  if (name.length > L.maxLen) return { ok: false, reason: `Razón social demasiado larga (máximo ${L.maxLen} caracteres).` };
  if (words.some((w) => w.length > L.maxWordLen)) return { ok: false, reason: `Cada palabra puede tener hasta ${L.maxWordLen} caracteres.` };
  return { ok: true, kind: 'nombre', value: name };
}
