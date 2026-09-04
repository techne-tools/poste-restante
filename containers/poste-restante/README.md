# containers/poste-restante — the house as a container

The deployment package for the house on the **Docker homelab host**
(SPEC §5 #14). This stack contains exactly one service — the house. It
attaches to the host's existing networks and resident services; it
duplicates nothing.

## What it connects to (the house reuses the house)

| Resident | Network | Host port | Reachable as |
|---|---|---|---|
| `shared-postgres` (postgres:15-alpine) | `backend_net` | none (internal) | `shared-postgres:5432` |
| `app-qdrant` | `web_net` | 21022 (host, for CLI) | `app-qdrant:6333` |
| `app-ollama` | `ollama_net` | 21023 (host, for CLI) | `app-ollama:11434` |

Verified 2026-09-04: docker 29.7.2 + compose v5.5.0 on the host, all three
networks exist, `nomic-embed-text` is served, and host ports
**21016 / 21027** (house HTTP / SMTP door) are free.

## Files

- `Dockerfile` — multi-stage: build (tsc + migrations copy) then a slim
  `node:22-alpine` runtime with production deps only, non-root.
- `compose.yml` — the house service on the three external networks.
  Environment is interpolated from `.env.public` + decrypted `.env.enc`
  (assembled by `deploy.sh`). `DATABASE_URL` points at `shared-postgres`
  by name with `${POSTGRES_PASSWORD}` (secret, from `.env.enc`).
- `.env.public` — non-secrets (committed). No values are secret here.
- `.env.enc` — **secrets, NOT committed** (sops+age, per AGENTS). Contains
  `POSTGRES_PASSWORD` (required) and `SMTP_OUTBOUND_URL` (optional; the
  outbound seam's relay).
- `deploy.sh` — assemble env → pre-flight → compose. See below.

## Deploy (from the host)

```bash
cd containers/poste-restante
sops -e .env.example > .env.enc   # or: sops --encrypt --key <age key> .env.example > .env.enc
                                  # then edit .env.enc with `sops .env.enc` — put the real POSTGRES_PASSWORD in
./deploy.sh config                # see the merged environment (names only)
./deploy.sh db:provision          # create the poste_restante DB on shared-postgres (idempotent)
./deploy.sh up -d --build         # build + start the house (default path)
./deploy.sh logs -f               # watch it self-migrate and listen
docker compose ps                 # poste-restante-house: up
curl -s http://127.0.0.1:21016/v1/health   # → {"status":"awake"}
```

Then seed a resident:
`docker exec -it poste-restante-house node server/dist/auth/cli.js add you@house`
and issue an invite the usual way. The house self-migrates on boot
(`connectDbAndMigrate`) — there is no separate migration step.

## Config knobs (all env-driven, all optional except the secret)

| Var | Default | Meaning |
|---|---|---|
| `POSTGRES_PASSWORD` | — | **required** (secret, .env.enc) — shared-postgres password |
| `AUTH_MODE` | `none` ⚠️ | `basic` in production. `none` = dev only; the house fails closed (door refuses) |
| `POSTGRES_DB` | `poste_restante` | DB the house provisions/uses on shared-postgres |
| `HOUSE_DOMAIN` | `house` | address-space boundary (SPEC §5 #13) |
| `SMTP_ENABLED` | `0` | 1 opens the SMTP door (host 21027) |
| `SMTP_OUTBOUND_URL` | unset | outbound relay; unset = seam dormant (SPEC §5 #13) |
| `GAP_PASS_INTERVAL_MS` | `21600000` (6 h) | gap-pass heartbeat; 0 disables |
| `BOOK_SETTLING_DAYS` | `7` | clause settling period |
| `QDRANT_COLLECTION` | `letters` | semantic collection (created on boot) |
| `EMBEDDING_MODEL` | `nomic-embed-text` | ollama model (`EMBEDDING_BASE_URL` fixed to `app-ollama:11434`) |

## Ops notes

- **watchtower is resident on the host.** The service carries
  `com.centurylinklabs.watchtower.enable=false` — the house image is built
  locally and named `poste-restante-house:local`; watchtower must not churn it.
- **The house is a single container.** No sidecars yet. When movement B
  (IMAP read-side, SPEC §5 #11/#12) lands, the Stalwart mailbox sidecar joins
  this stack as a second service on a free 21xxx port — the package is
  shaped for that.
- **Local dev is unaffected.** The dev Mac runs the native-processes dev
  house; this package is the target shape (SPEC §5 #14). Nothing here changes
  the dev workflow.
