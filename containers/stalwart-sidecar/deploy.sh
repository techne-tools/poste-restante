# Poste Restante — deploy on the Docker homelab host.
#
# Both packages (the house + the mailbox sidecar) live under
# containers/, each with their own deploy.sh. This is the sidecar's:
# build + lifecycle for the Stalwart IMAP mirror, plus the OPERATOR-GATED
# provisioning step (the plan-apply recipe).
#
#   ./deploy.sh up -d --build            # build + start the sidecar (v1: no provisioning)
#   ./deploy.sh sidecar:provision        # operator-gated: apply the plan via recovery mode
#   ./deploy.sh logs -f / down / ps …    # passthrough to docker compose
#
# The sidecar carries no secrets of its own at build time; per-resident
# IMAP credentials live in the Stalwart store (plan-created) and in the
# house's mailbox_accounts table (mailbox:add). The recovery port (18080)
# is published ONLY during the operator-gated provision, then closed.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

SERVICE_NAME="stalwart-sidecar"
COMPOSE="docker compose"

# ── subcommands ───────────────────────────────────────────────────────────
case "${1:-}" in
  sidecar:provision)
    # OPERATOR-GATED. Prints the recovery recipe; the actual plan file
    # lives with the operator (plan.ndjson pattern from the dev sidecar).
    echo "→ the sidecar must be RUNNING in normal mode, then:"
    echo "  1. publish recovery on 18080 (temporary, never permanent):"
    echo "     docker compose exec mailbox-sidecar sh -c 'STALWART_RECOVERY_MODE=1 \\"
    echo "       STALWART_RECOVERY_MODE_PORT=18080 STALWART_RECOVERY_ADMIN=\"admin:<secret>\" \\"
    echo "       stalwart -c /opt/stalwart/etc/config.json'"
    echo "  2. from the DEV MAC, apply the plan against the published port:"
    echo "     STALWART_URL=http://<host>:18080 stalwart-cli apply --user admin \\"
    echo "       --password '<secret>' --file plan.ndjson"
    echo "  3. kill the recovery exec; the normal IMAP listener takes over."
    echo "Provisioning is operator-gated — the house cannot do this step."
    ;;
  up|start|config|logs|down|ps|restart)
    exec $COMPOSE "${@}"
    ;;
  *)
    exec $COMPOSE "$@"
    ;;
esac
