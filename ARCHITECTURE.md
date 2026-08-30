# Architecture

<!-- impeccable:architecture-schema 1 -->

## Current Code Reality

**The house is built.** Phase 4 complete (2026-08-29): the archive spine, the letter server, the whisper, the reference client, and the MCP face are all implemented and verified. Phase 7 fix pass (2026-08-29) applied the design-review findings: bound design tokens, a11y pass, whisper reasoning, pub view, and the Horizon View re-sketch. The auth layer (2026-08-30) made authentication mandatory: basic (scrypt) and OIDC (PKCE) modes, participant-scoped authorization, and token auth for agents. The framework is still the product; the software is the reference implementation.

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
    db/             — postgres repository + migrations (001–007)
    qdrant/         — semantic store (768-dim ollama embeddings)
    embed/          — embedder (ollama local, OpenAI-compatible opt-in)
    pipeline/       — ingestion pipeline (row → embed → index → link), markdown→text, logger
    retrieval/      — three paths (exact, FTS, semantic) merged by RRF (k=60)
    whisper/        — the house's own letters: list/open/dismiss/undismiss, gap detection with visible reasoning
    auth/           — AuthService (scrypt, bearer tokens, OIDC RP), visibility rule, auth CLI
    mcp/            — the MCP face (17 tools) — agents become residents
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

The house speaks one contract (CONTRACT.md) through two faces that cannot drift — both share `schemas.ts` and `deliver.ts`:

- **HTTP** — the letter server (`/v1/letters`, `/v1/addresses/:addr/inbox`, `/v1/threads/:id`, `/v1/frames`, `/v1/whisper`). Pull by default; there is no push channel.
- **MCP** — 17 tools (deliver, search, mailbox, whisper, gaps). Registered with Hermes as `poste-restante`.

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

The mailbox for the house's own letters. House letters (kind `system` from `house@house`) surface on ingest; gap detection (dormant threads, unanswered questions) runs on demand via cheap postgres queries and carries **visible reasoning** — the house shows why it is offering a gap ("the last letter arrived more than 14 days ago…"). The learning loop: opening (signal) > ignoring (decay) > explicit dismissal (strongest negative); writing back is the strongest positive. Presence not pressure — the whisper is a GET resource.

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

| Layer | Choice |
|---|---|
| Letter server | TypeScript + Hono, dockerised |
| Letters/addresses/threads/frames | postgres 15 (shared instance) |
| Semantic layer | qdrant |
| Raw payloads | minio |
| Ingestion queue | redis |
| Local brain | ollama |
| Audio letters | faster-whisper |
| Bridges | IMAP/SMTP (primary), Matrix + ActivityPub (optional) |
| Reference client | Tauri v2 + React (callsheet lineage) |
| Agent integration | MCP server |
| Deployment | docker-compose, tailscale for access |

### The buildable first slice

```
postgres + qdrant + minio + redis + faster-whisper + ollama
```

Six containers. That's the whole archive. The letter server + IMAP bridge + whisper engine are the house software on top.

## Key Architectural Decisions

1. **Headless house, composed UI.** The house has no UI of its own — it exposes primitives as a protocol. The Tauri app is the reference client, not THE UI. (2026-08-29, resolved from "custom UI vs IMAP-as-UI".)
2. **Composable, not generative.** The user composes the space; the house generates the letters. Generative layout is the platform composing for you again.
3. **Plural time.** Gregorian as index, frames as addresses. The genuinely novel piece — no SaaS does this.
4. **RRF for retrieval.** Three paths (exact, FTS, semantic) merged by reciprocal rank fusion — ~50 lines, robust, lets you add a fourth path without re-tuning.
5. **The letter is the unit in all three tiers.** postgres row, qdrant vector, minio file — one archive, one unit.
6. **Local by default, cloud as explicit opt-in bridge.** Ollama for embeddings/models; OpenAI-compatible endpoint as one env var.
