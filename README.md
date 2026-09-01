# Poste Restante

> *Mail held at the post office until called for.*
>
> The whole philosophy in two words: the house holds your mail until you come for it. Nothing pushes.

**A house where everything is mail.** A self-hosted correspondence layer for the agentic stack: every thing gets an address, every address receives letters, every letter is kept, and nothing arrives unless you come for it.

**Status:** Phase 4/5 — the house is built and wired; Phase 7 fix pass applied. The archive spine (postgres + qdrant + FTS, merged by RRF), the letter server (Hono), the whisper (with visible reasoning), the reference client (Vite + React, Horizon View as a transit diagram, pub view), and the MCP face (agents as residents) are all live. Open Design window continues (2 months, granted 2026-08-29); the framework is the product, the software is the reference implementation.

## The one sentence

Every thing in your life gets an address, every address receives letters, every letter is kept, and nothing arrives unless you come for it.

## The design constraint (the floppy disk)

Pre-IRC, two 14-year-olds exchanged floppy disks with text files on them as letters. The principle still holds: **technology enables users to communicate on their own terms — or it should.** The house's constraint isn't 1.44MB, it's **asynchrony**: the letter waits. Nothing pushes. *Presence not pressure — hold, never ping; visible not sent.*

## The house

- **The address space is the spine.** Everything has an address (`you@house`, `hermes@house`, `feed:lurker@house`, `archive@house`). The address book is the social graph.
- **The mailbox protocol is the whole protocol.** Envelope + markdown body. Async by default. Threads are correspondences. Bridges to IMAP/SMTP, Matrix, ActivityPub.
- **The archive is the memory.** postgres (letters) + qdrant (semantics) + minio (payloads). **Plural time**: Gregorian is the index, frames are the addresses. Retrieval: exact + FTS + semantic, merged by RRF.
- **The resident is the collaborator.** The whisper surfaces the gap — six gap types, convergent by construction, derived from the active frame. Offer not audition, gap not surprise, reassessment not apology. The address is the meaning (Nancy).
- **The house is headless; the UI is composed.** The house has no UI of its own — it exposes primitives as a protocol. The user composes the space (cmux, shell, obsidian, neomutt); the house generates the letters. Composable, not generative.

## The constitution

Privacy as schema, anti-hierarchy as capability, queer/indigenous/global-majority empowerment as positive design, mutual aid as funding. Every value has a schema consequence. If the schema doesn't have it, the value isn't real.

## The stack

| Layer | Choice | Status |
|---|---|---|
| Letter server | TypeScript + Hono | ✅ built (`server/`) |
| Archive spine | postgres 15 (shared instance) + qdrant + FTS, merged by RRF | ✅ built |
| The whisper | house letters + gap detection (dormant threads, unanswered questions), visible reasoning | ✅ built |
| Reference client | Vite + React (Tauri v2 later) | ✅ built (`client/`) |
| Agent integration | MCP server — agents become residents | ✅ built, registered with Hermes |
| Raw payloads | minio (S3-compatible) | ⬜ target — out of two-month scope |
| Ingestion queue | redis | ⬜ target — out of two-month scope |
| Audio letters | faster-whisper | ⬜ target — out of two-month scope |
| Local brain | ollama (embeddings, 768-dim) | ✅ live |
| Bridges | IMAP/SMTP (primary), Matrix + ActivityPub (optional) | ⬜ target — out of two-month scope |
| Deployment | docker-compose, tailscale for access | ⬜ target — out of two-month scope |

## What this is not

- **Not a product with a price list.** No wallet, no x402, no USDC, no "100+ tools." Postage is free.
- **Not a platform.** A house. Small, domestic, self-hosted, yours.
- **Not a recommendation engine.** The house answers the question you asked and offers what's missing from the work you're doing. It does not try to keep you in the room.
- **Not a servant.** A resident. It offers, it reassesses, it can be wrong and says so.

## Run it

The house needs postgres 15 and qdrant (and ollama for embeddings). The server defaults to local infra:

```sh
npm install
npm run build          # server + client
npm test               # unit tests (server + client)
npm run test:integration --workspace server   # needs POSTE_RESTANTE_INTEGRATION=1 + live infra
```

```sh
npm run serve --workspace server     # the letter server, http://localhost:8787
npm run dev --workspace client       # the reference client, http://localhost:5173 (proxies /v1)
npm run serve:mcp --workspace server # the MCP face — agents become residents
```

The MCP face is registered with Hermes as `poste-restante` (17 tools: deliver, search, mailbox, whisper, gaps). The house is headless — the client is *a* client, not *the* client.

## Documents

- `SPEC.md` — the framework spec (v0.1, for Open Design review)
- `SKETCH.md` — the manifesto
- `PRODUCT.md` — product intent
- `DESIGN.md` — design north star
- `ARCHITECTURE.md` — current code reality
- `CONTRACT.md` — the protocol contract

## License

AGPL-3.0. The house is a house, not a product — the code is as free as the postage.
