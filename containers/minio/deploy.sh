#!/usr/bin/env bash
# Poste Restante — MinIO payload store deploy on the Docker homelab host.
#
#   ./deploy.sh up -d                # start MinIO
#   ./deploy.sh logs -f / down / ps  # passthrough to docker compose
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

COMPOSE="docker compose"

# 1. Load public env
if [[ -f .env.public ]]; then
  set -a
  source .env.public
  set +a
fi

# 2. Decrypt secret env if present
if [[ -f .env.enc ]]; then
  TMP_ENV="$(mktemp)"
  trap 'rm -f "$TMP_ENV"' EXIT
  sops -d .env.enc > "$TMP_ENV"
  set -a
  source "$TMP_ENV"
  set +a
fi

exec $COMPOSE "$@"
