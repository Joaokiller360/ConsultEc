# syntax=docker/dockerfile:1

# ConsultaEC — imagen de producción (Astro SSR con adapter Node standalone)
# Node 24 LTS: incluye node:sqlite sin flags (base de datos abierta de la Supercias).
ARG NODE_IMAGE=node:24-bookworm-slim

# ───────── 1. Build ─────────
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --no-audit --no-fund
COPY . .
RUN npm run build

# ───────── 2. Dependencias de producción ─────────
FROM ${NODE_IMAGE} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --no-audit --no-fund && npm cache clean --force

# ───────── 3. Runtime ─────────
FROM ${NODE_IMAGE} AS runtime
ENV NODE_ENV=production \
    HOST=0.0.0.0 \
    PORT=4321 \
    SUPERCIAS_DB=/app/data/supercias.db \
    NODE_NO_WARNINGS=1
WORKDIR /app

COPY --from=deps  --chown=node:node /app/node_modules ./node_modules
COPY --from=build --chown=node:node /app/dist ./dist
COPY --chown=node:node package.json ./
# Importador de datos abiertos de la Supercias (se ejecuta bajo demanda, ver README)
COPY --chown=node:node scripts ./scripts

# Volúmenes: base de datos importada y bitácoras de auditoría de convenios
RUN mkdir -p /app/data /app/logs && chown -R node:node /app/data /app/logs
VOLUME ["/app/data", "/app/logs"]

USER node
EXPOSE 4321

HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||4321)+'/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["node", "dist/server/entry.mjs"]
