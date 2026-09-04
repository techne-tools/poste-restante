# Architecture

<!-- impeccable:architecture-schema 1 -->

## Current Code Reality

**The house is built and breathing.** Phase 4 complete (2026-08-29): the archive spine, the letter server, the whisper, the reference client, and the MCP face are all implemented and verified. Phase 7 fix pass (2026-08-29) applied the design-review findings: bound design tokens, a11y pass, whisper reasoning, pub view, and the Horizon View re-sketch. The auth layer (2026-08-30) made authentication mandatory: basic (scrypt) and OIDC (PKCE) modes, participant-scoped authorization, and token auth for agents. The plumbing phase opened 2026-09-04 with the living pass: the gap engine now runs per resident on a schedule and the whisper sorts by the learning loop. The framework is still the product; the software is the reference implementation.

### What exists

```
server/   — the house. TypeScript, Hono, postgres 15 + qdrant + FTS.
  src/
    index.ts        — buildHouse(): wires db, qdrant, pipeline, retrieval, whisper
    server.ts       — the letter server (Hono, /v1/*)
    main.ts         — entry point
    schemas.ts      — the letter contract (zod) — shared by HTTP + MCP faces
    deliver.ts      — deliverLetter(): shared delivery logic (ingest → whisper → reply)
    types.ts        — envelope, frame, kinds (letter | feed | system | audio | note | task)
    id.ts           — letterId: sha256 of canonical envelope+body → deterministic UUID for qdrant
    db/             — postgres repository + migrations (001–014)
    qdrant/         — semantic store (768-dim ollama embeddings)
    embed/          — embedder (ollama local, OpenAI-compatible opt-in)
    pipeline/       — ingestion pipeline (row → embed → index → link), markdown→text, logger
    retrieval/      — three paths (exact, FTS, semantic) merged by RRF (k=60)
    whisper/        — the house's own letters: list/open/dismiss/undismiss, gap detection with visible reasoning,
                      and the scheduled gap pass (scheduler.ts — the house breathes)
    auth/           — AuthService (scrypt, bearer tokens, OIDC RP), visibility rule, auth CLI
    mcp/            — the MCP face (17 tools) — agents become residents
    bridge/         — the bridge layer: smtp.ts (the SMTP door — the house meets real mail),
                      threads.ts (re:-subject thread resolution for inbound mail),
                      outbound.ts (the outbound seam — the house writes, SPEC §5 #13)
client/   — the reference client. Vite + React, calm design tokens bound to .impeccable/design.json (seal wax, no red).
  src/
    api.ts          — the house protocol as a client (POST deliver, GET mailbox); auth-gated, attaches the
                    Authorization header from persisted AuthState, plus the OIDC start/callback routes
    Login.tsx       — login view (basic + OIDC); persists AuthState (address + header) to localStorage
    App.tsx         — shell: mailbox / archive / addresses / compose / pub + whisper sidebar, gated on login
    Mailbox.tsx, LetterView.tsx (envelope details toggle), Archive.tsx (Horizon View — transit diagram),
    AddressBook.tsx (one-tap compose), Compose.tsx (correction path), Pub.tsx (pub@house),
    WhisperSidebar.tsx (reasoning disclosure + write back)
```

### The protocol faces

The house speaks one contract (CONTRACT.md) through three faces — two of
them can't drift because they share `schemas.ts` and `deliver.ts`; the
bridge translates at the door (SPEC §5 #10):

- **HTTP** — the letter server (`/v1/letters`, `/v1/addresses/:addr/inbox`, `/v1/threads/:id`, `/v1/frames`, `/v1/whisper`). Pull by default; there is no push channel.
- **MCP** — 17 tools (deliver, search, mailbox, whisper, gaps). Registered with Hermes as `poste-restante`.
- **SMTP (inbound)** — the door (`server/src/bridge/smtp.ts`). A resident with a house credential can write mail to `SMTP_BIND` (default `127.0.0.1:2525`, enabled by `SMTP_ENABLED=1`) and it becomes a letter through the same pipeline. Envelope from = authenticated address (the no-forging invariant, verbatim).
- **SMTP (outbound)** — the seam (`server/src/bridge/outbound.ts`, SPEC §5 #13). A letter addressed to an external domain (≠ `HOUSE_DOMAIN`) is relayed via `SMTP_OUTBOUND_URL` after it is stored (store first, relay second — never lose a letter). Ships dormant (unset = closed); refuses `AUTH_MODE=none` and its own door. nodemailer transport.

### Identity

`letterId` is a SHA256 of the canonical envelope + body. Qdrant requires UUIDs, so the first 32 hex chars map to a deterministic UUID. A caller-supplied id is ignored — the hash is the identity. Ingestion is idempotent.

### Authentication & authorization

**Identity = address.** There is no user table: a credential is a capability to act as an address. Credentials live in a separate `credentials` table (migration 007) — the secrets and the social graph never share a table, and only hashes are stored (scrypt for passwords, sha256 for bearer tokens, the provider `sub` for OIDC bindings).

- **Modes** — `AUTH_MODE=basic | oidc | both | none` (none is development only). Basic is stateless scrypt over `Authorization: Basic`; OIDC is a Relying Party (authorization code + PKCE, `client_secret_post`) with JWKS-verified id_tokens.
- **The owner issues credentials** via `npm run auth:add -- <address>` (password) or `--token` (bearer). No self-signup; the house never auto-creates identities.
- **Private by default** — every read and mutation is scoped to the caller's address via `isVisibleTo` (participant from/to/cc, or public via `pub@house`). Absence is silence: unauthorized reads return 404, never 403.
- **No forging** — the envelope's `from` must be the caller's own address (403 otherwise).
- **Agents** — the MCP face authenticates with `POSTE_RESTANTE_TOKEN`; no token → fail closed.
- **The pub** — `pub@house` is the schema-level public exception; its mailbox is readable unauthenticated.

### Retrieval

Three paths, merged by RRF (k=60): exact (postgres envelope), full-text (postgres FTS), semantic (qdrant). Ranking uses the house's own signals — recency (gentle decay), thread weight, correspondent weight, frame match, explicit pins. Never engagement, virality, or "you might also like."

### The whisper

The mailbox for the house's own letters. House letters (kind `system` from `house@house`) surface on ingest; gap detection (all six types — dormant threads, unanswered questions, two voices, unvisited corners, uncited connections, echoes, plus the citation of the book) carries **visible reasoning** — the house shows why it is offering a gap ("the last letter arrived more than 14 days ago…"). The learning loop: opening (signal) > ignoring (decay) > explicit dismissal (strongest negative); writing back is the strongest positive. The whisper sorts by the loop — replied → opened → recency — so it surfaces what the resident actually engages with. **The scheduled pass** (since 2026-09-04) runs detection per resident on `GAP_PASS_INTERVAL_MS` (default 6h; 0 disables); it only stores whispers, never pushes. Presence not pressure — the whisper is a GET resource.

### The reference client

Calm by contract: design tokens bound to `.impeccable/design.json` (OKLch hue 95 paper, hue 70 ink, seal wax accent), no red for errors, no pings or badges. The **Horizon View** renders plural time as a transit diagram — a sticky frame rail with parallel lines, letters as dots on their frames, and dimming (not filtering) of non-matching letters. The **pub** is a view of the public address `pub@house` — the pub is an address, not a schema. The **whisper sidebar** shows the house's reasoning behind each gap offer and offers **Write back** as the primary action. The correction path pre-addresses Compose to the house: "the house is wrong" is a letter.

### Deletion

First-class and cascading. `ON DELETE CASCADE` across letters → letter_addresses, letter_frames, whispers. No soft delete. The archive forgets on request.

## Target Architecture (from SPEC.md)

### The address space (the spine)

Everything has an address. If it doesn't have an address, it doesn't exist in the house.

```
you@house              — the human
hermes@house           — the stage manager
research@house         — a persona, a resident
ben@house              — a human correspondent
feed:lurker@house      — an RSS subscription you entered into
channel:theatre@house  — a group letter
circle:collab@house    — a Google+ circle: write to the circle, not the feed
archive@house          — the house memory
```

The address book is the social graph. No follower counts, no feeds — just who you correspond with.

### The mailbox protocol

Every letter is an envelope + body. Envelope: from, to, cc, thread, kind, lang, subject, frames. Body: markdown. That's the whole protocol.

- Async by default. The letter waits.
- Threads are correspondences. The thread is the unit, not the message.
- Internal protocol: HTTP + JSON + markdown. Every address is a resource. Delivery is a POST to an inbox. Pull by default.
- Bridges: IMAP/SMTP (primary), Matrix + ActivityPub (optional), NNTP (steal the threading model).

### The archive

Three tiers, one archive. The letter is the unit in all three.

```
postgres     — the letters (envelope + body, threads, addresses, frames)
qdrant       — the semantic layer (embeddings of bodies)
minio        — the raw payloads (audio, video, images) — S3-compatible
```

Plural time: Gregorian is the index; frames are the addresses. Retrieval: exact (postgres envelope) + full-text (postgres FTS) + semantic (qdrant), merged by RRF. Ranking uses the house's own signals: recency (gentle decay), thread weight, correspondent weight, frame match, explicit pins. Never engagement, virality, "you might also like."

Fluidity → persistence: every letter starts fluid (a row, a vector) and becomes persistent (compressed into summaries). The compression is a letter too — retrievable, inspectable, reversible.

### The resident (the whisper)

Callsheet's ghost cards scaled from daily to conversational. The sidebar is the mailbox for the house's own letters. The learning loop is the collaboration: replying (strongest) > opening the linked letter > ignoring (decay) > explicit dismissal (strongest negative). The relevance tables are visible and correctable. The gap engine maps the active frame's territory and finds what's missing — the six gap types.

### The stack

The house lives on **the Docker homelab host** (corrected 2026-09-04 — the macOS/native story was a dev convenience, never the target). The house reuses the house: the stack attaches to the host's resident services rather than duplicating them — `shared-postgres` (postgres:15-alpine — the "reuse shared postgres 15" decision made literal), `app-qdrant` (host 21022), `app-ollama` (host 21023), plus shared-redis/whisper. Local dev runs on a Mac as native processes (postgres 15 5433, qdrant 6333, ollama 11434). The `containers/<service>/` convention (compose + deploy.sh, ports 21000 range) is the deployment shape. The rows below mix what exists with what the design still names as targets.

| Layer | Choice | Status today |
|---|---|---|
| Letter server | TypeScript + Hono | ✅ container next (dev: `npm run serve`) |
| Letters/addresses/threads/frames | postgres 15 (shared instance) | ✅ `shared-postgres` (dev 5433) |
| Semantic layer | qdrant | ✅ `app-qdrant` 21022 (dev 6333) |
| Raw payloads | minio | ⬜ target — stub today (`NoopPayloadStore`) |
| Ingestion queue | redis | ⬜ target — `shared-redis` resident, unused |
| Local brain | ollama | ✅ `app-ollama` 21023 (dev 11434) |
| Audio letters | faster-whisper | ⬜ target — `whisper` resident, unused |
| Bridges | IMAP/SMTP (primary), Matrix + ActivityPub (optional) | ⬜ in-flight — the SMTP door (in) + outbound seam (dormant) live; IMAP read-side next |
| Reference client | Vite + React (Tauri was the original lineage) | ✅ `client/` |
| Agent integration | MCP server | ✅ `server/src/mcp/` |
| Deployment | docker stack + oauth-proxy/routing | ⬜ first slice — `containers/poste-restante/` |

### The buildable first slice

```
host:    postgres (shared-postgres) + qdrant (21022) + ollama (21023)   ← resident services, reused
         poste-restante (server container) + stalwart (IMAP, 21xxx)     ← the house's own services
dev mac: the same software as native processes                          ← dev box, not the target
```

The letter server + whisper engine + scheduler are the house software on top. The first deployment slice is the `containers/poste-restante/` package (Dockerfile + compose service + .env.public + deploy.sh, host ports in the free 21xxx range — 21016/21027/21032/21033 are free as of 2026-09-04) wiring the house to the host's resident postgres/qdrant/ollama, exactly as AGENTS.md specifies.

## Key Architectural Decisions

1. **Headless house, composed UI.** The house has no UI of its own — it exposes primitives as a protocol. The Tauri app is the reference client, not THE UI. (2026-08-29, resolved from "custom UI vs IMAP-as-UI".)
2. **Composable, not generative.** The user composes the space; the house generates the letters. Generative layout is the platform composing for you again.
3. **Plural time.** Gregorian as index, frames as addresses. The genuinely novel piece — no SaaS does this.
4. **RRF for retrieval.** Three paths (exact, FTS, semantic) merged by reciprocal rank fusion — ~50 lines, robust, lets you add a fourth path without re-tuning.
5. **The letter is the unit in all three tiers.** postgres row, qdrant vector, minio file — one archive, one unit.
6. **Local by default, cloud as explicit opt-in bridge.** Ollama for embeddings/models; OpenAI-compatible endpoint as one env var.
