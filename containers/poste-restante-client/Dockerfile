# syntax=docker/dockerfile:1

# Poste Restante — the reference client, as a container.
#
# The house is headless (invariant 1): this container is NOT part of the
# house image — it is the reference client, composed by the operator for
# alpha testers. It serves the built React client as static files and
# proxies /v1 to the house on backend_net. Testers get the composed space;
# the house remains a protocol.
#
#   ./deploy.sh up -d --build   # build the client bundle + start serving

FROM node:22-alpine AS build

WORKDIR /app

# Workspace manifests first (npm ci wants them all present, then layer-cached).
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY client/package.json client/

RUN npm ci

# Client sources.
COPY client client

# Compile the reference client (tsc + vite build → client/dist).
RUN npm run build --workspace @poste-restante/client

# ── runtime: serve the static bundle + proxy the protocol ────────────────
FROM nginx:1.27-alpine

# nginx runs master-as-root to bind 80 and drops to the nginx user for
# workers (needs SETUID/SETGID + NET_BIND_SERVICE — cap_drop: ALL is NOT
# applied here, unlike the house image, because it breaks the worker drop;
# the surface is static files + a reverse proxy behind the house's auth).
# no-new-privileges still applies.
COPY containers/poste-restante-client/nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/client/dist /usr/share/nginx/html

EXPOSE 80

CMD ["nginx", "-g", "daemon off;"]
