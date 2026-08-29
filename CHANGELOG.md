# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
