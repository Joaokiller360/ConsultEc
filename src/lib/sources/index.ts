import type { Mode, Query, Source, SourceResult } from '../types';
import { fiscalia } from './fiscalia';
import { judicial } from './judicial';
import { antecedentes } from './antecedentes';
import { supercias } from './supercias';
import { directorio } from './directorio';
import { sercop } from './sercop';
import { sri } from './sri';
import { uafe } from './uafe';
import { interpol, policia } from './policia';
import { superbancos } from './superbancos';

export const SOURCES: Source[] = [sri, antecedentes, judicial, fiscalia, directorio, supercias, sercop, uafe, policia, interpol, superbancos];

/** Fuentes relevantes por modo, en el orden en que se muestran. */
export const ORDER: Record<Mode, string[]> = {
  persona: ['sri', 'antecedentes', 'judicial', 'fiscalia', 'policia', 'interpol', 'uafe', 'superbancos', 'sercop'],
  empresa: ['sri', 'cias', 'supercias', 'sercop', 'judicial', 'fiscalia', 'uafe', 'superbancos'],
};

export const getSource = (id: string) => SOURCES.find((s) => s.id === id);

export async function runSource(src: Source, q: Query): Promise<SourceResult> {
  const base = { id: src.id, name: src.name, officialUrl: src.officialUrl };
  const t0 = Date.now();
  if (!src.supports.includes(q.kind)) {
    return {
      ...base,
      status: 'na',
      summary: `Esta fuente no permite búsquedas por ${q.kind === 'nombre' ? 'nombre' : q.kind === 'ruc' ? 'RUC' : 'cédula'}.`,
    };
  }
  try {
    const r = await src.run(q);
    return { ...base, ...r, officialUrl: r.officialUrl ?? src.officialUrl, elapsedMs: Date.now() - t0 };
  } catch (e) {
    const msg = e instanceof Error ? (e.name === 'AbortError' ? 'La fuente tardó demasiado en responder.' : e.message) : 'Error desconocido';
    return { ...base, status: 'error', summary: msg, elapsedMs: Date.now() - t0 };
  }
}
