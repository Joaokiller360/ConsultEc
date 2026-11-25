import type { APIRoute } from 'astro';
import { getSource, runSource } from '../../../lib/sources';
import type { Mode } from '../../../lib/types';
import { detect } from '../../../lib/validate';
import { clientIp, limited } from '../../../lib/ratelimit';

export const prerender = false;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
  });

export const GET: APIRoute = async (ctx) => {
  const { params, url, request } = ctx;
  const src = getSource(params.source ?? '');
  if (!src) return json({ error: 'Fuente desconocida' }, 404);

  const ip = clientIp(request, () => ctx.clientAddress);
  if (limited(ip)) return json({ error: 'Demasiadas consultas. Espera un minuto.' }, 429);

  const raw = url.searchParams.get('q') ?? '';
  const mode: Mode = url.searchParams.get('m') === 'empresa' ? 'empresa' : 'persona';
  const d = detect(raw, mode);
  if (!d.ok) return json({ error: d.reason }, 400);

  const result = await runSource(src, { raw, kind: d.kind, value: d.value, mode, ip });
  return json(result);
};
