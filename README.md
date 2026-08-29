# Poste Restante

> *Mail held at the post office until called for.*
>
> The whole philosophy in two words: the house holds your mail until you come for it. Nothing pushes.

**A house where everything is mail.** A self-hosted correspondence layer for the agentic stack: every thing gets an address, every address receives letters, every letter is kept, and nothing arrives unless you come for it.

**Status:** Spec v0.1 — framework + design phase (Open Design, 2 months). No production code yet.

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

| Layer | Choice |
|---|---|
| Letter server | TypeScript + Hono, dockerised |
| Letters/addresses/threads/frames | postgres 16 |
| Semantic layer | qdrant |
| Raw payloads | minio |
| Ingestion queue | redis |
| Local brain | ollama |
| Audio letters | faster-whisper |
| Bridges | IMAP/SMTP (primary), Matrix + ActivityPub (optional) |
| Reference client | Tauri v2 + React (callsheet lineage) |
| Agent integration | MCP server |
| Deployment | docker-compose, tailscale for access |

## What this is not

- **Not a product with a price list.** No wallet, no x402, no USDC, no "100+ tools." Postage is free.
- **Not a platform.** A house. Small, domestic, self-hosted, yours.
- **Not a recommendation engine.** The house answers the question you asked and offers what's missing from the work you're doing. It does not try to keep you in the room.
- **Not a servant.** A resident. It offers, it reassesses, it can be wrong and says so.

## Documents

- `SPEC.md` — the framework spec (v0.1, for Open Design review)
- `SKETCH.md` — the manifesto
- `PRODUCT.md` — product intent
- `DESIGN.md` — design north star
- `ARCHITECTURE.md` — current code reality
- `CONTRACT.md` — the protocol contract

## License

AGPL-3.0. The house is a house, not a product — the code is as free as the postage.
