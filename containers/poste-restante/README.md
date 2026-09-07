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
**21016 / 21036** (house HTTP / SMTP door) are free.

## The tailnet face (host-serve — the sidecar collapse)

The house is exposed on the tailnet by the **host's single Tailscale node**,
not a container. This is the fleet model since the sidecar collapse
(complete 2026-08-23 — 30 per-stack sidecars → zero, ~2.4 GiB RAM saved).
`horza` (100.91.100.103) already runs every stack's serve line from
`~/containers/restore-tailscale-serve.sh`; this package adds two entries:

```bash
# on horza, as root — register the house's slots in the host serve map
tailscale serve --bg --https=21016 --service svc:poste-restante "http://127.0.0.1:21016"
```

- **Tailnet:** `https://poste-restante.mermaid-darter.ts.net:21016` → the
  house's `/v1` (TLS terminated by the host node; the tailnet name is
  registered as `svc:poste-restante` in the admin console).
- **No sidecar container.** The house stack publishes host ports and lets
  the host node proxy loopback — one less ~80 MB container vs the old
  fleet pattern, and nothing in this package to break with namespace
  games.
- **No `TS_AUTHKEY`.** The host node is already authenticated; per-stack
  pre-auth keys died with the sidecars.
- The **SMTP door (21036) gets no serve line** — the door wants a relay,
  not a public TLS face. (The draft's 21027 was home-assistant's serve
  slot on horza; the door now sits on its own port.)

## Files

- `Dockerfile` — multi-stage: build (tsc + migrations copy) then a slim
  `node:22-alpine` runtime with production deps only, non-root.
- `compose.yml` — the house service on the three external networks.
  Environment is interpolated from `.env.public` + decrypted `.env.enc`
  (assembled by `deploy.sh`). `DATABASE_URL` points at `shared-postgres`
  by name with `${POSTGRES_PASSWORD}` (secret, from `.env.enc`).
- `.env.public` — non-secrets (committed). No values are secret here.
- `.env.enc` — **secrets, NOT committed** (sops+age, per AGENTS). Contains
  `POSTGRES_PASSWORD` (required), `MINIO_ACCESS_KEY`/`MINIO_SECRET_KEY`
  (enclosures), and `SMTP_OUTBOUND_URL` (optional; the outbound seam's
  relay). **No `TS_AUTHKEY`** — the tailnet is the host node's job (host-
  serve).
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
| `MINIO_ACCESS_KEY` | — | **required for enclosures** (secret, .env.enc); both keys activate the S3 payload store |
| `MINIO_SECRET_KEY` | — | **required for enclosures** (secret, .env.enc) |
| `AUTH_MODE` | `none` ⚠️ | `basic` in production. `none` = dev only; the house fails closed (door refuses) |
| `POSTGRES_DB` | `poste_restante` | DB the house provisions/uses on shared-postgres |
| `HOUSE_DOMAIN` | `house` | address-space boundary (SPEC §5 #13) |
| `SMTP_ENABLED` | `0` | 1 opens the SMTP door (host 21036) |
| `SMTP_OUTBOUND_URL` | unset | outbound relay; unset = seam dormant (SPEC §5 #13) |
| `GAP_PASS_INTERVAL_MS` | `21600000` (6 h) | gap-pass heartbeat; 0 disables |
| `BOOK_SETTLING_DAYS` | `7` | clause settling period |
| `QDRANT_COLLECTION` | `letters` | semantic collection (created on boot) |
| `EMBEDDING_MODEL` | `nomic-embed-text` | ollama model (`EMBEDDING_BASE_URL` fixed to `app-ollama:11434`) |
| `MINIO_BUCKET` | `letters` | payload bucket (`MINIO_ENDPOINT` fixed to `app-minio:9000`) |
| `REDIS_URL` | `redis://shared-redis:6379` | ingestion queue + pub/sub (fixed in compose) |
| `WHISPER_URL` | `http://whisper:9000` | audio transcription (fixed in compose; whisper attached to backend_net at deploy) |

## Ops notes

- **watchtower is resident on the host.** The service carries
  `com.centurylinklabs.watchtower.enable=false` — the house image is built
  locally and named `poste-restante-house:local`; watchtower must not churn it.
- **The house is a single container.** The Stalwart mailbox sidecar
  (`containers/stalwart-sidecar/`) is a separate package — it joins on the
  same backend_net when the mailbox seam is enabled (alpha phase 2). The
  house reaches it by compose DNS `mailbox-sidecar:11430`.
- **whisper is not on the house's networks.** The house sets
  `WHISPER_URL=http://whisper:9000`; the whisper container lives on its own
  `whisper_default` network. Attach it once at deploy:
  `docker network connect backend_net whisper`. Until then, audio letters
  store fine and sit untranscribed (presence-not-pressure).
- **Local dev is unaffected.** The dev Mac runs the native-processes dev
  house; this package is the target shape (SPEC §5 #14). Nothing here changes
  the dev workflow.
