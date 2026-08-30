# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — authentication & authorization (2026-08-30)

- **Authentication is mandatory** — `AUTH_MODE=basic | oidc | both | none` (none is development only). Identity = address: a credential is a capability to act as a specific address. No user table, no admin class, no roles. (`server/src/auth/service.ts`, `server/src/config.ts`)
- **Basic auth** — stateless scrypt over `Authorization: Basic base64(address:password)`. Only a scrypt hash is stored; the house never holds a password. (`server/src/auth/service.ts`)
- **OIDC** — the house is a Relying Party: authorization code + PKCE, `client_secret_post`, JWKS-verified id_tokens. First login binds the provider `sub` to the owner address. (`server/src/auth/service.ts`, `server/src/server.ts`)
- **Credentials schema** — `credentials` table (migration 007) decoupled from the social graph; password hashes, bearer-token hashes, and OIDC subject bindings. (`server/src/db/migrations/007_credentials.sql`)
- **Auth CLI** — `npm run auth:add -- <address>` (password), `--token` (bearer), `auth:list`, `auth:remove`. The owner issues credentials; no self-signup. (`server/src/auth/cli.ts`)
- **Private by default** — every read and mutation is scoped to the caller's address via `isVisibleTo` (participant from/to/cc, or public via `pub@house`). Absence is silence: unauthorized reads return 404, never 403. (`server/src/auth/visibility.ts`)
- **No forging** — the envelope's `from` must be the caller's own address; a letter claiming another address is refused (403).
- **Agent auth** — the MCP face authenticates with `POSTE_RESTANTE_TOKEN`; no token → fail closed. (`server/src/mcp/server.ts`, `server/src/mcp/main.ts`)
- **The pub is public** — `pub@house` is the schema-level public exception; its mailbox is readable unauthenticated.
- **Client login** — the reference client gates on a login view (basic + OIDC), persists the credential locally, and uses the authenticated address everywhere. (`client/src/Login.tsx`, `client/src/api.ts`, `client/src/App.tsx`)
- **Tests** — 18 auth unit tests (scrypt, tokens, mode gating, visibility) and 10 auth integration tests (auth required, scoping, pub, forging) against live infra. 98/98 passing.

### Added (2026-08-29)

- **The sketch** — the manifesto: address space, mailbox protocol, archive with plural time, constitution, retrieval layer, the resident. (`SKETCH.md`)
- **The framework spec v0.1** — the working document for Open Design: constitution as schema table, architecture, stack pegged, two-month scope, open questions. (`SPEC.md`)
- **The headless decision** — the house has no UI of its own; the user composes the space. Composable, not generative. (SPEC §2.5)
- **Repo scaffold** — governance docs (PRODUCT, DESIGN, ARCHITECTURE, CONTRACT, PIPELINE, TASK, RECON, DEVISING), LICENSE (AGPL-3.0), .gitignore, .impeccable config, .github (FUNDING, CI).

### Added — Phase 4a: the archive spine (2026-08-29)

- **Postgres schema** — letters, addresses, threads, frames, letter_addresses, letter_frames, whispers. Cascading deletion, no soft delete. (`server/src/db/migrations/001–005`)
- **Semantic layer** — qdrant store with 768-dim ollama embeddings; deterministic UUID mapping from the letter hash. (`server/src/qdrant/`, `server/src/embed/`)
- **Ingestion pipeline** — idempotent: row → embed → index → link. (`server/src/pipeline/`)
- **Retrieval** — three paths (exact, FTS, semantic) merged by RRF (k=60); ranking by recency, thread/correspondent weight, frame match, pins — never engagement. (`server/src/retrieval/`)
- **Identity** — `letterId` is a SHA256 of the canonical envelope + body; caller-supplied ids are ignored. (`server/src/id.ts`)

### Added — Phase 4b: the letter server (2026-08-29)

- **Hono letter server** — `/v1/letters` (deliver, search, get, delete, pin), `/v1/addresses` (book + inbox), `/v1/threads/:id`, `/v1/frames`, `/v1/whisper`. Pull by default; no push channel. (`server/src/server.ts`)
- **Shared contract** — zod schemas (`server/src/schemas.ts`) and `deliverLetter()` (`server/src/deliver.ts`) shared by the HTTP and MCP faces so they cannot drift.

### Added — the whisper and the reference client (2026-08-29)

- **The whisper** — the mailbox for the house's own letters: list/open/dismiss/undismiss, house-letter surfacing on ingest, cheap structural gap detection (dormant threads, unanswered questions). (`server/src/whisper/`)
- **The reference client** — Vite + React, calm design tokens (seal wax accent, no red for errors), mailbox, letter view, Horizon View (plural time as parallel lanes), address book, compose, whisper sidebar. (`client/`)

### Added — the MCP face (2026-08-29)

- **Agents become residents** — 17 MCP tools (deliver, search, mailbox, whisper, gaps) mirroring the letter server over the shared contract. (`server/src/mcp/`)
- **Protocol-channel fix** — the MCP face logs to stderr; stdout is the JSON-RPC channel. (`server/src/pipeline/logger.ts`)
- **Registered with Hermes** as `poste-restante` — the house is addressable from any agent session.

### Added — Phase 5 drudge (2026-08-29)

- **Client unit tests** — the protocol client (`client/src/api.ts`) covered with a mocked fetch: deliver, search, mailbox, whisper, delete, error handling. (`client/src/api.test.ts`)
- **Root scripts** — `npm test` and `npm run build` now cover both workspaces; CI runs the full suite.
- **Docs brought current** — README status/stack/run-it, ARCHITECTURE current code reality, CHANGELOG, PIPELINE/TASK phase gates.

### Fixed — Phase 7 fix pass (2026-08-29)

- **Token pass** — `styles.css` rewritten to consume the bound tokens from `.impeccable/design.json` (OKLch hue 95 paper, hue 70 ink); primary buttons invert to ink on hover; accent usage audited to ≤2 per surface; envelope metadata collapsed behind a quiet `<details>` toggle. (`client/src/styles.css`, `client/src/LetterView.tsx`)
- **Accessibility** — global `:focus-visible` ring using the accent; frame chips and letter rows converted from `div`/`span` to real `<button>`s with `aria-pressed` on the frame rail. (`client/src/Archive.tsx`, `client/src/styles.css`)
- **Whisper reasoning** — migration `006_whisper_reasoning.sql` adds a `reasoning` column; gap whispers now carry visible reasoning ("the last letter arrived more than 14 days ago…"); the client renders it in an expandable disclosure with a **Write back** action. (`server/src/db/migrations/006_whisper_reasoning.sql`, `server/src/whisper/service.ts`, `client/src/WhisperSidebar.tsx`)
- **Surfaces** — address rows get one-tap compose; the correction path pre-addresses Compose to the house; quiet mono kind kickers on letter rows; **Pub view** implemented as the inbox of `pub@house` — the pub is an address, no schema change. (`client/src/AddressBook.tsx`, `client/src/Compose.tsx`, `client/src/Mailbox.tsx`, `client/src/Pub.tsx`, `client/src/App.tsx`)
- **Horizon View re-sketch** — the archive now renders the transit-diagram metaphor from DESIGN.md: a sticky frame rail with parallel lines, letters as dots on their frames, and dimming (not filtering) of non-matching letters. (`client/src/Archive.tsx`, `client/src/styles.css`)
