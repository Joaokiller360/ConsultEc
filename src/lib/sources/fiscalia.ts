import { cached, fetchT, parseHtmlTables } from '../http';
import type { Source, Table } from '../types';

/**
 * Consulta de noticias del delito (Fiscalía General del Estado).
 * El formulario público envía el criterio serializado en formato PHP a este endpoint,
 * que devuelve HTML con una tabla por cada noticia del delito.
 */
const ENDPOINT = 'https://www.gestiondefiscalias.gob.ec/siaf/comunes/noticiasdelito/info.php';

/**
 * Igual que el formulario oficial: el criterio se separa por espacios/comas y cada
 * palabra se serializa como elemento de un array PHP. La longitud va en bytes UTF-8,
 * que es lo que espera unserialize() de PHP.
 */
function businfo(value: string) {
  const words = value.split(/[\s,]+/).filter(Boolean);
  const items = words.map((w, i) => `i:${i};s:${new TextEncoder().encode(w).length}:"${w.replace(/"/g, '')}";`).join('');
  return `a:${words.length}:{${items}}`;
}

function toTables(raw: string[][][]): Table[] {
  return raw.map((rows) => {
    const width = Math.max(...rows.map((r) => r.length));
    // tablas "clave: valor" (2 columnas) o con encabezado en la primera fila
    if (width === 2 && rows.length > 1) {
      return { columns: ['Campo', 'Detalle'], rows };
    }
    if (rows.length === 1) {
      return { columns: [''], rows: [[rows[0].join(' · ')]] };
    }
    const [head, ...body] = rows;
    return { columns: head, rows: body.map((r) => (r.length < head.length ? [...r, ...Array(head.length - r.length).fill('')] : r)) };
  });
}

export const fiscalia: Source = {
  id: 'fiscalia',
  name: 'Noticias del delito',
  institution: 'Fiscalía General del Estado',
  officialUrl: 'https://www.fiscalia.gob.ec/accesibilidad/consulta-de-noticias-del-delito/',
  supports: ['cedula', 'ruc', 'nombre'],
  async run(q) {
    const html = await cached(`fge:${q.value}`, 30 * 60_000, async () => {
      const res = await fetchT(`${ENDPOINT}?businfo=${encodeURIComponent(businfo(q.value))}`, {}, 20000);
      if (!res.ok) throw new Error(`Fiscalía respondió ${res.status}`);
      return res.text();
    });

    if (/captcha/i.test(html)) {
      return { status: 'manual', summary: 'La Fiscalía solicita verificación humana para esta consulta.' };
    }

    const raw = parseHtmlTables(html);
    const nddCount = (html.match(/NOTICIA DEL DELITO/gi) ?? []).length;
    if (!raw.length || /no\s+(se\s+)?(encontr|exist)/i.test(html.replace(/<[^>]+>/g, ' ')) && !nddCount) {
      return { status: 'empty', summary: 'Sin noticias del delito registradas para este criterio.' };
    }

    return {
      status: 'ok',
      summary: nddCount ? `${nddCount} noticia(s) del delito asociadas.` : 'Registros encontrados.',
      stats: nddCount ? [{ label: 'Noticias del delito', value: String(nddCount) }] : undefined,
      tables: toTables(raw),
      note:
        'Figurar en una noticia del delito no implica culpabilidad: puede ser como denunciante, víctima, testigo o sospechoso. ' +
        'Usar esta información con fines discriminatorios (Constitución, art. 11.2) o vulnerando la presunción de inocencia (art. 76.2) ' +
        'se sanciona con hasta 5 años de prisión (COIP, art. 176).',
    };
  },
};
