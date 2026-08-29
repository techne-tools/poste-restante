# Product

<!-- impeccable:product-schema 1 -->

## Platform

Self-hosted correspondence layer (the "house"). Server: TypeScript + Hono, dockerised on the host. Reference client: Tauri v2 + React (macOS). Any client works — the house speaks a protocol, not a UI.

## Stack

TypeScript + Hono letter server; postgres 15 (letters/addresses/threads/frames — reuses the shared instance); qdrant (semantic); minio (payloads); redis (queue); ollama (local brain); faster-whisper (audio letters); IMAP/SMTP bridge (primary), Matrix + ActivityPub (optional); Tauri v2 + React reference client; MCP server for agent integration; docker-compose on the host.

## Users

A single primary user (the resident) — a maker/researcher/teacher who runs a distributed agentic stack (Hermes, Noema, iai-pme, LCM, Obsidian, Zotero) across three machines. The house is the correspondence layer that holds it all: every thing gets an address, every address receives letters, every letter is kept, and nothing arrives unless you come for it. The user composes their own space from clients (cmux, shell, obsidian, neomutt, the reference client); the house never composes the space for them.

## Product Purpose

Poste Restante is a house where everything is mail. It replaces the platform/service model with a house/correspondence model: async by default, presence not pressure, the archive as the memory, the resident as a collaborator who offers rather than serves. Success means the user's whole life — letters, feeds, agents, archives, audio — lives in one addressable, searchable, plural-time house that holds rather than pings.

## Positioning

A house, not a product. No wallet, no pricing, no "100+ tools" — correspondents, not tools. The hook for artists and weirdos: correspondence as the universal interface. The floppy disk principle: technology enables users to communicate on their own terms — or it should. The house is headless; the UI is composed. The resident offers (generosity, confidence, visible reasoning), finds the gap (what's missing from the work, not what matches), and reassesses rather than apologises.

## Operating Context

- **The address space is the spine.** Everything has an address (`you@house`, `hermes@house`, `feed:lurker@house`, `archive@house`). The address book is the social graph.
- **The mailbox protocol is the whole protocol.** Envelope + markdown body. Async by default. Threads are correspondences. Bridges to IMAP/SMTP, Matrix, ActivityPub.
- **The archive is the memory.** postgres (letters) + qdrant (semantics) + minio (payloads). Plural time: Gregorian is the index, frames are the addresses. Retrieval: exact + FTS + semantic, merged by RRF.
- **The resident is the collaborator.** The whisper surfaces the gap — six gap types, convergent by construction, derived from the active frame. The learning loop is the collaboration: replying is the strongest signal; the relevance tables are visible and correctable.
- **The constitution is the architecture.** Privacy as schema, anti-hierarchy as capability, queer/indigenous/global-majority empowerment as positive design, mutual aid as funding. Every value has a schema consequence.

## What this is not

- **Not a product with a price list.** No wallet, no x402, no USDC, no "100+ tools." Postage is free.
- **Not a platform.** A house. Small, domestic, self-hosted, yours.
- **Not a recommendation engine.** The house answers the question you asked and offers what's missing from the work you're doing. It does not try to keep you in the room.
- **Not a servant.** A resident. It offers, it reassesses, it can be wrong and says so. The address is the meaning.
