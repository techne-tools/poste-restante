# syntax=docker/dockerfile:1

# Poste Restante — the house, as a container.
#
# Only the *server* ships in this image: the house is headless (invariant 1),
# a protocol on port 8787 (HTTP/MCP) and 2525 (the SMTP door, closed by
# default). The reference client is composed by the user, not served here.
#
# The house reuses the house: at runtime it attaches to shared-postgres,
# app-qdrant and app-ollama on the host's existing docker networks — this
# image builds and runs the house software, nothing else.

FROM node:22-alpine AS build

WORKDIR /app

# Workspace manifests first (npm ci wants them all present, then layer-cached).
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

# Full install — the build needs the server's devDependencies (tsc).
RUN npm ci

# Sources.
COPY server server
COPY client client

# Compile the server only. The build script also copies the migrations into
# dist/db/migrations, which the runtime needs (the house self-migrates on boot).
RUN npm run build --workspace @poste-restante/server

# ── runtime ────────────────────────────────────────────────────────────────
FROM node:22-alpine

ENV NODE_ENV=production
WORKDIR /app

# Workspace manifests + a production install (server runtime deps only).
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/
RUN npm ci --omit=dev

# The compiled house + its migrations.
COPY --from=build /app/server/dist /app/server/dist

# Non-root. The house writes nothing locally — the archive is postgres, the
# semantics qdrant — so node's user is the right one to run as.
USER node

EXPOSE 8787 2525

# AUTH_MODE/AUTH is configured via the environment; the house fails closed
# without it. Entry point: the compiled letter server.
CMD ["node", "server/dist/main.js"]
