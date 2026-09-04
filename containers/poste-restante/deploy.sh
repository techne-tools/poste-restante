#!/usr/bin/env bash
# Poste Restante — deploy the house on the Docker homelab host.
#
# Convention (AGENTS.md): .env.public carries non-secrets; .env.enc holds
# secrets (sops+age); deploy.sh merges them into a temporary .env, runs a
# pre-flight, then hands off to docker compose. The temporary .env is
# shredded on exit.
#
#   ./deploy.sh config            # show the merged environment (names only)
#   ./deploy.sh db:provision      # create poste_restante on shared-postgres (idempotent)
#   ./deploy.sh up -d --build     # build + start the house (default)
#   ./deploy.sh logs -f
#   ./deploy.sh down
#
# Required secret: POSTGRES_PASSWORD (the shared-postgres password, from
# .env.enc or the environment). Without it the house DB cannot be provisioned
# and DATABASE_URL is not interpolated — fail closed, like the house itself.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SERVICE_NAME="poste-restante"
MERGED_ENV=".env"
DB_NAME="${POSTGRES_DB:-poste_restante}"
DB_USER="${POSTGRES_USER:-audiomuse}"

cleanup() {
  shred -u "$MERGED_ENV" 2>/dev/null || rm -f "$MERGED_ENV"
}
trap cleanup EXIT INT TERM

# ── assemble the environment ──────────────────────────────────────────────
if [[ -f .env.public ]]; then
  cp .env.public "$MERGED_ENV"
else
  : > "$MERGED_ENV"
fi

if [[ -f .env.enc ]]; then
  sops --decrypt .env.enc >> "$MERGED_ENV" && chmod 600 "$MERGED_ENV"
fi

# Compose interpolates ${POSTGRES_PASSWORD} from this .env; load it for the
# provisioning check and for our own expansion. Never print the password.
set -a
# shellcheck disable=SC1090
source "$MERGED_ENV"
set +a

if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
  echo "❌ POSTGRES_PASSWORD is not set (put it in .env.enc, not .env.public)." >&2
  echo "   The house fails closed — no DB, no DATABASE_URL, no start." >&2
  exit 1
fi

# ── subcommands ───────────────────────────────────────────────────────────
SUB=""
case "${1:-}" in
  config)
    echo "# ${SERVICE_NAME} — merged environment (values hidden)"
    sed -E 's/=.*/=<redacted>/' "$MERGED_ENV" | grep -vE '^\s*(#|$)' | sort
    exit 0
    ;;
  db:provision|up|start)
    SUB="${1}"
    shift
    ;;
  *)
    # everything else (logs, down, ps, ...) passes straight through
    exec docker compose "$@"
    ;;
esac

# ── db:provision — idempotent: create the house DB if it does not exist ───
db_exists="$(docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" shared-postgres \
  psql -U "$DB_USER" -d postgres -tAc \
  "SELECT 1 FROM pg_database WHERE datname = '$DB_NAME';" 2>/dev/null || true)"

if [[ "$db_exists" == "1" ]]; then
  echo "✓ database $DB_NAME already exists on shared-postgres"
else
  echo "→ creating database $DB_NAME on shared-postgres…"
  docker exec -e PGPASSWORD="$POSTGRES_PASSWORD" shared-postgres \
    psql -U "$DB_USER" -d postgres -c "CREATE DATABASE \"$DB_NAME\";" >/dev/null
  echo "✓ created $DB_NAME (the house self-migrates on boot)"
fi

if [[ "$SUB" == "db:provision" ]]; then
  exit 0
fi

# ── up / start — build the house image and bring it up ────────────────────
# The house image is built locally (no registry), so the default path builds
# too. Compose flags are forwarded as-is ("-d", "--force-recreate", ...);
# when the caller passes none, default to detached + build.
exec docker compose up $([[ $# -eq 0 ]] && echo "-d --build") "$@"
