#!/usr/bin/env bash
# Poste Restante — deploy the reference client on the Docker homelab host.
#
# The client container carries no credentials (auth lives in the browser and
# travels to the house through the proxy), and tailnet access is host-serve
# on the horza node (the sidecar collapse, 2026-08-23) — there is nothing to
# decrypt or pre-flight here. Everything (logs, down, ps, config, ...) passes
# straight through to docker compose.
#
#   ./deploy.sh up -d --build     # build the client bundle + start (default)
#   ./deploy.sh logs -f
#   ./deploy.sh down

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

# up / start — build the client image (the Dockerfile builds client/dist in
# its build stage) and bring the stack up. Compose flags forward as-is; when
# none are passed, default to detached + build.
if [[ "${1:-}" == "up" || "${1:-}" == "start" ]]; then
  shift
  exec docker compose up $([[ $# -eq 0 ]] && echo "-d --build") "$@"
fi

exec docker compose "$@"
