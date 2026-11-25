/**
 * Lectura del Certificado de Antecedentes Penales (Ministerio del Interior) que el usuario
 * descarga del portal oficial. Todo ocurre en el navegador: el PDF no se envía a ningún servidor.
 */
import { isCedula } from './validate';

export interface CertInfo {
  esCertificado: boolean;
  nombre?: string;
  documento?: string;
  /** 'SI' | 'NO' | undefined si no se pudo determinar */
  antecedentes?: 'SI' | 'NO';
  emision?: Date;
  validoHasta?: Date;
  vigente?: boolean;
  numero?: string;
  enlaces: string[];
  texto: string;
}

const MONTHS: Record<string, number> = {
  enero: 0, febrero: 1, marzo: 2, abril: 3, mayo: 4, junio: 5, julio: 6,
  agosto: 7, septiembre: 8, setiembre: 8, octubre: 9, noviembre: 10, diciembre: 11,
};

const DATE_RE =
  /(\d{1,2})[\/-](\d{1,2})[\/-](\d{4})|(\d{4})-(\d{2})-(\d{2})|(\d{1,2})\s+de\s+([a-záéíóú]+)\s+(?:de|del)\s+(\d{4})/gi;

function parseDate(m: RegExpExecArray): Date | undefined {
  let d: Date | undefined;
  if (m[1]) d = new Date(Number(m[3]), Number(m[2]) - 1, Number(m[1]));
  else if (m[4]) d = new Date(Number(m[4]), Number(m[5]) - 1, Number(m[6]));
  else if (m[7]) {
    const mo = MONTHS[m[8].toLowerCase()];
    if (mo !== undefined) d = new Date(Number(m[9]), mo, Number(m[7]));
  }
  return d && !Number.isNaN(d.getTime()) ? d : undefined;
}

function datesIn(s: string): { date: Date; index: number }[] {
  const out: { date: Date; index: number }[] = [];
  const re = new RegExp(DATE_RE.source, 'gi');
  let m: RegExpExecArray | null;
  while ((m = re.exec(s))) {
    const d = parseDate(m);
    if (d) out.push({ date: d, index: m.index });
  }
  return out;
}

/** Fecha que aparece justo después de una etiqueta (máx. 60 caracteres). */
function dateAfter(text: string, label: RegExp): Date | undefined {
  const m = label.exec(text);
  if (!m) return undefined;
  const tail = text.slice(m.index + m[0].length, m.index + m[0].length + 60);
  return datesIn(tail)[0]?.date;
}

const VALIDITY_DAYS = 90;

export function parseCertText(raw: string, now = new Date()): CertInfo {
  const texto = raw.replace(/\s+/g, ' ').trim();
  const T = texto.toUpperCase();

  // ── Formato oficial actual del Ministerio del Interior ──
  // Las etiquetas son parte de la plantilla gráfica; la capa de texto solo trae los valores, en este orden:
  //   <fecha emisión> <n.º certificado> <tipo documento> <n.º documento> <APELLIDOS NOMBRES> <SI|NO>
  //   Válido hasta el <fecha> … MINISTERIO DEL INTERIOR - POLICÍA NACIONAL
  const FECHA = String.raw`\d{1,2}\s+DE\s+[A-ZÁÉÍÓÚ]+\s+DEL?\s+\d{4}`;
  const oficial = new RegExp(
    String.raw`(${FECHA})\s+([0-9]{8,20}[A-Z]?)\s+(C[EÉ]DULA DE IDENTIDAD|PASAPORTE)\s+([A-Z0-9]{5,20})\s+` +
      String.raw`([A-ZÁÉÍÓÚÑÜ][A-ZÁÉÍÓÚÑÜ ]+?)\s+(SI|SÍ|NO)\s+V[AÁ]LIDO\s+HASTA\s+EL\s+(${FECHA})`,
  ).exec(T);

  if (oficial && /MINISTERIO\s+DEL\s+INTERIOR/.test(T)) {
    const emision = datesIn(oficial[1])[0]?.date;
    const validoHasta = datesIn(oficial[7])[0]?.date;
    return finish(
      {
        esCertificado: true,
        emision,
        validoHasta,
        numero: oficial[2],
        documento: oficial[4],
        nombre: oficial[5].trim(),
        antecedentes: oficial[6].startsWith('S') ? 'SI' : 'NO',
      },
      texto,
      now,
    );
  }

  // ── Respaldo: certificados con etiquetas en el texto ──
  const esCertificado = /ANTECEDENTES\s+PENALES/.test(T) && /(MINISTERIO\s+DEL\s+INTERIOR|POLIC[IÍ]A\s+NACIONAL)/.test(T);

  const documento =
    (T.match(/\b\d{10}\b/g) ?? []).find(isCedula) ??
    T.match(/(?:N[UÚ]MERO\s+DE\s+DOCUMENTO|PASAPORTE)\s*:?\s*([A-Z0-9]{6,15})/)?.[1];

  let antecedentes: CertInfo['antecedentes'];
  const posee = T.match(/POSEE\s+ANTECEDENTES\s*(?:PENALES)?\s*:?\s*(SI|SÍ|NO)\b/);
  if (posee) antecedentes = posee[1].startsWith('S') ? 'SI' : 'NO';
  else if (/\bNO\s+(REGISTRA|POSEE|TIENE|MANTIENE)\s+ANTECEDENTES/.test(T)) antecedentes = 'NO';
  else if (/\b(REGISTRA|POSEE|TIENE|MANTIENE)\s+ANTECEDENTES/.test(T)) antecedentes = 'SI';

  const nombre =
    T.match(/(?:APELLIDOS\s+Y\s+NOMBRES|NOMBRES\s+Y\s+APELLIDOS|NOMBRES?)\s*:?\s*([A-ZÁÉÍÓÚÑÜ]+(?:\s+[A-ZÁÉÍÓÚÑÜ]+){1,5})/)?.[1]
      ?.replace(/\s+(TIPO|N[UÚ]MERO|C[EÉ]DULA|DOCUMENTO|CON|POSEE|IDENTIFICAD[OA]).*$/, '')
      .trim() ??
    T.match(/CIUDADAN[OA](?:\/A)?\s+([A-ZÁÉÍÓÚÑÜ]+(?:\s+[A-ZÁÉÍÓÚÑÜ]+){1,5}?)\s+(?:CON|PORTADOR|IDENTIFICAD)/)?.[1];

  const numero = T.match(
    /(?:N[UÚ]MERO\s+DE\s+CERTIFICADO|CERTIFICADO\s+N(?:RO|[ÚU]MERO|º|°|O)?\.?|C[OÓ]DIGO(?:\s+DE\s+(?:VERIFICACI[OÓ]N|VALIDACI[OÓ]N))?)\s*:?\s*([A-Z0-9][A-Z0-9-]{5,})/,
  )?.[1];

  const emision =
    dateAfter(texto, /fecha\s+de\s+(emisi[oó]n|expedici[oó]n|generaci[oó]n)\s*:?/i) ?? datesIn(texto)[0]?.date;
  const validoHasta = dateAfter(texto, /(v[aá]lid[oa]\s+hasta(\s+el)?|fecha\s+de\s+(validez|caducidad|vencimiento))\s*:?/i);

  return finish({ esCertificado, nombre, documento, antecedentes, emision, validoHasta, numero }, texto, now);
}

function finish(
  info: Omit<CertInfo, 'vigente' | 'enlaces' | 'texto'>,
  texto: string,
  now: Date,
): CertInfo {
  let { validoHasta } = info;
  if (!validoHasta && info.emision) validoHasta = new Date(info.emision.getTime() + VALIDITY_DAYS * 86_400_000);
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const vigente = validoHasta ? validoHasta.getTime() >= today.getTime() : undefined;
  const enlaces = [...new Set(texto.match(/https?:\/\/[^\s"'<>]+/gi) ?? [])].filter((u) =>
    /(ministeriodelinterior|gob\.ec|firmadigital|firmaec)/i.test(u),
  );
  return { ...info, validoHasta, vigente, enlaces, texto };
}

/** Extrae el texto de un PDF con pdf.js (carga diferida, solo cuando se sube un archivo). */
export async function pdfToText(file: File): Promise<string> {
  const pdfjs = await import('pdfjs-dist');
  const worker = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = worker;

  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const parts: string[] = [];
  for (let p = 1; p <= Math.min(doc.numPages, 5); p++) {
    const page = await doc.getPage(p);
    const content = await page.getTextContent();
    parts.push(content.items.map((it) => ('str' in it ? it.str : '')).join(' '));
    // anotaciones de enlace (p. ej. URL de verificación del QR)
    const annots = await page.getAnnotations();
    for (const a of annots) if (a.url) parts.push(a.url);
  }
  await doc.cleanup();
  return parts.join('\n');
}
