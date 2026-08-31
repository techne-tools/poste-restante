# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added — invitation-only membership, the invite letter (2026-08-31)

- **The join flow is a letter** — a resident mints a dormant address and writes a `kind: "invite"` letter to it; the voucher edge (`owner@house wrote to guest@house`) *is* the social graph. (`server/src/invites/service.ts`)
- **`invite` letter kind** — added to `LETTER_KINDS`; `letters_kind_check` re-added with the new value. First-class: redemption is one-time state, and it is a capability granted by a peer. (`server/src/types.ts`, `server/src/db/migrations/008_invites.sql`)
- **Schema** — one new table, five columns: `invites (letter_id PK→letters CASCADE, created_by→addresses, code_hash, expires_at nullable, redeemed_at nullable, redeemed_by→addresses)`. Only `code_hash` is stored, never the code; revocation is just deletion of the letter. (`server/src/db/migrations/008_invites.sql`)
- **Mint CLI** — `npm run invite:new -- <owner> <guest>`: the owner vouches, the code is printed once (human-typable `XXXX-XXXX-XXXX`), shown to the guest out of band. (`server/src/invites/cli.ts`)
- **Redeem route** — `POST /v1/invites/redeem` (public, like health: the guest has no credential yet). Proves possession of the letter + the code; the claim is atomic (`UPDATE ... WHERE redeemed_at IS NULL` + credential grant in one transaction), so exactly one redemption wins. Fail closed: every negative path answers 404 — absence is silence. (`server/src/server.ts`)
- **Tests** — 12 invite unit tests (code generation, hashing, mint, redeem happy + wrong code / wrong address / spent / expired / already-resident / short password) and 7 integration tests (full mint → redeem → authenticate arc, one-time, all negatives) against live infra. 117/117 passing.
- **SPEC §5.7 open question resolved (2026-08-31): in scope, built.** CONTRACT documents the invitation-only membership contract.
- **Reference client redemption UI** — the door has a quiet third way in: "A resident invited you? Enter with your invitation" flips Login between sign-in and redemption. The guest presents address + one-time code + the password they choose; redemption persists the credential and walks them in — no second door. Fail closed in the client too: a 404 maps to the same single answer. (`client/src/Redeem.tsx`, `client/src/Login.tsx`, `client/src/api.ts`)
- **Client redeem unit tests** — prove `redeemInvite` never attaches an Authorization header even with a stale resident session (the guest redeems as themselves), and maps every negative path to the one absence answer. 8/8 client, 125/125 suite. (`client/src/api.test.ts`)
- **Horizon View, real** — the plural-time archive browser (SPEC §6, DESIGN.md "the unit and the frame"). The letter flow is now a single vertical axis; frame lines flank it full-height like a transit diagram. Multi-frame selection brings the *intersection* forward: letters in every selected frame stay full, in some mid-dim, in none dim — nothing is removed. (`client/src/Archive.tsx`, `client/src/frameUtils.ts`)
- **Dev-mode fix** — `AUTH_MODE=*** actually disables auth now: the server previously always wired in the AuthService, so `none` never reached the routes. (`server/src/main.ts`)
- **The gap surface, real** — the offer protocol as UI (SPEC §2.4, §6 #2). The whisper's "Open" now lands on the correspondence itself: a new `ThreadView` reads the thread oldest first — the thread is the unit, not the message. Writing back on a whispered thread refreshes the sidebar so the strongest signal (replied) is visible, not just recorded. (`client/src/ThreadView.tsx`, `client/src/App.tsx`, `client/src/WhisperSidebar.tsx`)
- **The serif voice names the thread** — gap summaries now speak the latest letter's subject ("A correspondence has gone quiet — the last letter in “the tempest tech week”…"), never a raw thread id. The machine's index stays in the reasoning, where it belongs. (`server/src/whisper/service.ts`)
- **Gap detection bug fixed** — the unanswered-question regex `'\\\\?'` in the TS template literal reached Postgres as `'\\?'` (backslash + quantifier), matching *every* letter: every old thread was flagged as a waiting question. Now `'\?'` — a literal question mark. The new negative integration test (an old thread with no question mark is *not* flagged) is what caught it; the positive-only test never could. 117/117 server, 19/19 client.
- **The letter format, as a design artifact** — SPEC §6 #3, DESIGN.md "the unit and the frame", `.impeccable/design.json` → `surfaces.letter`. A letter now reads as a letter, not a chat bubble, not a feed card: the envelope is a single mono address line (`to: chris@house · from: hermes@house`) with the kind as the seal; the subject is the writer's serif; the frames are a quiet mono line under it; the body is the reader's sans at a 34em letter measure; the signoff is the writer's italic hand. The machine metadata (cc, thread, lang, received) is one quiet disclosure away, never in the way. (`client/src/LetterView.tsx`, `client/src/styles.css`)
- **Markdown, real** — the body renderer is extracted and extended: inline bold, italic, code, and links on top of the existing blocks (headings, blockquotes, lists, paragraphs). No HTML passthrough, no `dangerouslySetInnerHTML` — the renderer builds React nodes directly. (`client/src/markdown.tsx`)
- **A hang, caught by the tests** — the inline tokeniser originally used a shared module-level regex with `exec`; the recursive call for link text reset `lastIndex` and looped forever (the test run OOM'd at 8 GB). `matchAll` clones the regex per iterator, so recursion can never disturb the outer scan. Any letter containing a link would have hung the client. 11 new renderer tests, 30/30 client, 117/117 server.

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
