import { cached, fetchT, fmtDate } from '../http';
import type { Source } from '../types';

const BASE = 'https://srienlinea.sri.gob.ec/sri-catastro-sujeto-servicio-internet/rest';

export interface SriContribuyente {
  numeroRuc: string;
  razonSocial: string;
  estadoContribuyenteRuc: string;
  actividadEconomicaPrincipal: string;
  tipoContribuyente: string;
  regimen: string;
  categoria: string | null;
  obligadoLlevarContabilidad: string;
  agenteRetencion: string;
  contribuyenteEspecial: string;
  informacionFechasContribuyente?: {
    fechaInicioActividades?: string;
    fechaCese?: string;
    fechaReinicioActividades?: string;
    fechaActualizacion?: string;
  };
  representantesLegales?: { identificacion: string; nombre: string }[] | null;
  motivoCancelacionSuspension?: string | null;
  contribuyenteFantasma?: string;
  transaccionesInexistente?: string;
}

interface Establecimiento {
  nombreFantasiaComercial: string | null;
  tipoEstablecimiento: string;
  direccionCompleta: string;
  estado: string;
  numeroEstablecimiento: string;
  matriz: string;
}

/** Busca un contribuyente por RUC (o cédula → RUC persona natural ...001). */
export function sriLookup(id: string): Promise<SriContribuyente | null> {
  const ruc = id.length === 10 ? `${id}001` : id;
  return cached(`sri:${ruc}`, 30 * 60_000, async () => {
    const res = await fetchT(`${BASE}/ConsolidadoContribuyente/obtenerPorNumerosRuc?&ruc=${ruc}`);
    if (res.status === 204 || res.status === 404) return null;
    if (!res.ok) throw new Error(`SRI respondió ${res.status}`);
    const data = (await res.json()) as SriContribuyente[];
    return data?.[0] ?? null;
  });
}

async function establecimientos(ruc: string): Promise<Establecimiento[]> {
  try {
    const res = await fetchT(`${BASE}/Establecimiento/consultarPorNumeroRuc?numeroRuc=${ruc}`, {}, 10000);
    if (!res.ok || res.status === 204) return [];
    return (await res.json()) as Establecimiento[];
  } catch {
    return [];
  }
}

const flag = (label: string, v?: string | null) => (v ? { label, value: v } : null);

export const sri: Source = {
  id: 'sri',
  name: 'Registro Único de Contribuyentes',
  institution: 'SRI',
  officialUrl: 'https://srienlinea.sri.gob.ec/sri-en-linea/SriRucWeb/ConsultaRuc/Consultas/consultaRuc',
  supports: ['cedula', 'ruc'],
  async run(q) {
    const c = await sriLookup(q.value);
    if (!c) {
      return {
        status: 'empty',
        summary:
          q.kind === 'cedula'
            ? 'Esta cédula no tiene RUC registrado como persona natural.'
            : 'No existe un contribuyente con este RUC.',
      };
    }
    const f = c.informacionFechasContribuyente ?? {};
    const est = await establecimientos(c.numeroRuc);
    const alerts: string[] = [];
    if (c.contribuyenteFantasma === 'SI') alerts.push('Marcado como contribuyente fantasma');
    if (c.transaccionesInexistente === 'SI') alerts.push('Reporta transacciones inexistentes');

    return {
      status: 'ok',
      summary: `${c.razonSocial} · ${c.estadoContribuyenteRuc}`,
      note: alerts.length ? `⚠ ${alerts.join(' · ')}` : undefined,
      fields: [
        { label: 'RUC', value: c.numeroRuc },
        { label: 'Razón social', value: c.razonSocial },
        { label: 'Estado', value: c.estadoContribuyenteRuc },
        { label: 'Tipo', value: c.tipoContribuyente },
        { label: 'Régimen', value: [c.regimen, c.categoria].filter(Boolean).join(' · ') },
        { label: 'Actividad principal', value: c.actividadEconomicaPrincipal },
        { label: 'Inicio de actividades', value: fmtDate(f.fechaInicioActividades) },
        flag('Fecha de cese', f.fechaCese ? fmtDate(f.fechaCese) : null),
        flag('Motivo cancelación/suspensión', c.motivoCancelacionSuspension),
        { label: 'Obligado a llevar contabilidad', value: c.obligadoLlevarContabilidad },
        { label: 'Agente de retención', value: c.agenteRetencion },
        { label: 'Contribuyente especial', value: c.contribuyenteEspecial },
        { label: 'Última actualización', value: fmtDate(f.fechaActualizacion) },
      ].filter((x): x is { label: string; value: string } => !!x && !!x.value),
      tables: [
        ...(c.representantesLegales?.length
          ? [
              {
                title: 'Representantes legales',
                columns: ['Identificación', 'Nombre'],
                rows: c.representantesLegales.map((r) => [r.identificacion, r.nombre]),
              },
            ]
          : []),
        ...(est.length
          ? [
              {
                title: `Establecimientos (${est.length})`,
                columns: ['N.º', 'Nombre comercial', 'Dirección', 'Estado'],
                rows: est.map((e) => [
                  `${e.numeroEstablecimiento}${e.matriz === 'SI' ? ' · Matriz' : ''}`,
                  e.nombreFantasiaComercial ?? '—',
                  e.direccionCompleta,
                  e.estado,
                ]),
              },
            ]
          : []),
      ],
    };
  },
};
