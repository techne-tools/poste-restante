# Architecture

<!-- impeccable:architecture-schema 1 -->

## Current Code Reality

**No production code yet.** This repo is the working document for the Open Design phase (2 months, granted 2026-08-29). The framework is the product; the software is a reference implementation.

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
| Letters/addresses/threads/frames | postgres 16 |
| Semantic layer | qdrant |
| Raw payloads | minio |
| Ingestion queue | redis |
| Local brain | ollama |
| Audio letters | faster-whisper |
| Bridges | IMAP/SMTP (primary), Matrix + ActivityPub (optional) |
| Reference client | Tauri v2 + React (callsheet lineage) |
| Agent integration | MCP server |
| Deployment | docker-compose on horza, tailscale |

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
