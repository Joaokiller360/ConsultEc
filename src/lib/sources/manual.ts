import type { Source } from '../types';

/**
 * Fuentes cuyo portal oficial exige captcha, aceptación de términos o sesión interactiva
 * (aplicaciones JSF / ZK). No se automatizan: se enlaza al portal oficial.
 */

export const antecedentes: Source = {
  id: 'antecedentes',
  name: 'Certificado de antecedentes penales',
  institution: 'Ministerio del Interior',
  officialUrl: 'https://certificados.ministeriodelinterior.gob.ec/gestorcertificados/antecedentes/',
  supports: ['cedula'],
  async run() {
    return {
      status: 'manual',
      summary:
        'El portal está protegido por un captcha (hCaptcha) y registra un motivo de consulta por cada solicitud, por eso se obtiene directamente allí.',
      tables: [
        {
          title: 'Pasos en el portal oficial',
          columns: ['#', 'Paso'],
          rows: [
            ['1', 'Resuelve la verificación de seguridad (hCaptcha).'],
            ['2', 'Acepta los Términos y Condiciones de Uso.'],
            ['3', '¿Ciudadano ecuatoriano? → SI · Tipo: Cédula · pega la cédula copiada → Siguiente.'],
            ['4', 'Confirma el nombre y escribe el motivo de consulta (mínimo 10 caracteres).'],
            ['5', 'Verás "Posee antecedentes: SI/NO" → "Visualizar Certificado" descarga el PDF firmado (válido 90 días).'],
          ],
        },
      ],
      note: 'Por Decreto Ejecutivo 1166 ninguna entidad pública ni privada puede exigir este certificado como requisito.',
    };
  },
};

export const supercias: Source = {
  id: 'supercias',
  name: 'Portal de documentos societarios',
  institution: 'Superintendencia de Compañías, Valores y Seguros',
  officialUrl: 'https://appscvsmovil.supercias.gob.ec/portaldedocumentos/consulta_cia_param.zul',
  supports: ['ruc', 'nombre'],
  async run(q) {
    return {
      status: 'manual',
      summary: 'Expedientes, nombramientos, accionistas y estados financieros se consultan en el portal de la Supercias.',
      note:
        q.kind === 'ruc'
          ? 'Busca por RUC en el portal (el identificador ya está copiado). Los datos tributarios de la compañía están en la tarjeta del SRI.'
          : 'Busca por nombre/razón social en el portal.',
    };
  },
};
