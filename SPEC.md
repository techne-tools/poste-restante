---
tags:
  - project
  - poste-restante
  - spec
  - opendesign
  - architecture
created: 2026-08-29
status: spec-v0.1
description: "Poste Restante framework spec — for Open Design. The house where everything is mail, pegged to a tech stack, scoped for two months."
---

# Poste Restante — Framework Spec v0.1

> **Status:** v0.1 — for Open Design review
> **Audience:** Open Design reviewers, designers, future builders
> **Companion:** [[Poste Restante]] (the sketch/manifesto — this spec is the working document)
> **Origin:** 2026-08-29. Started as "what is micro/mu?" — became a house.

---

## 0. The one-sentence

**Every thing in your life gets an address, every address receives letters, every letter is kept, and nothing arrives unless you come for it.**

Poste Restante is a self-hosted "house where everything is mail" — a correspondence layer for the agentic stack. Not a platform, not a product with a price list: a house. The owner hooks in their own stack; the house provides the plumbing — addresses, mailboxes, archive, and a resident who offers rather than serves.

**The design constraint (the floppy disk):** pre-IRC, two 14-year-olds exchanged floppy disks with text files on them as letters. The principle: *technology enables users to communicate on their own terms — or it should.* The house's constraint isn't 1.44MB, it's **asynchrony**: the letter waits. Nothing pushes. *Presence not pressure — hold, never ping; visible not sent.*

---

## 1. Vision & principles

### 1.1 The constitution (values as architecture)

**The founding text.** Written by the household, 2026-09-02. It is not a decoration; it is the test every other clause and every schema decision answers to:

> this place is safe, it is kind, and it is just. it is the place that we make by being here as the selves we are and share. it is a living place but not the only place that lives, so it inhabits the world with the care and strength that we wish to share.

Every value has a schema consequence. If the schema doesn't have it, the value isn't real. The founding text, read as architecture:

| Clause | Schema/architecture consequence |
|---|---|
| **"this place is safe"** | Fail-closed visibility (privacy row below). The house cannot leak who harmed whom, because it cannot leak who corresponds with whom. |
| **"it is kind"** | Presence, not pressure (§1.3). The whisper offers, never pings; doors may always refuse, with no explanation required; divergence is two voices held at full weight, never adjudicated (§1.2). Kindness in the collective register — held by a household, not only one resident toward another — is the house book (§5.8), where the household's norms live as letters. |
| **"and it is just"** | Justice is third after safety and kindness: the house cannot be just with people it doesn't feel safe with, nor just without first being kind. Justice is not a tribunal — it is the book: norms as letters, traceable to real residents, amendable by anyone, reversible by correspondence. The house enforces **stated** will, never **inferred** will. |
| **"we make by being here"** | The book's head is *derived* from what residents write and hold — constitutive, never declared by a keeper. Membership is ongoing presence, not a one-time key (§5.8, leaving as first-class — the move that protects you from someone protects them from you). |
| **"as the selves we are and share"** | Diversity as mechanism: singular-plural (Nancy), two voices, divergence held (§1.2). The selves we are (the interval) and what we share (the commons — the book is the one genuinely commons thing). |
| **"a living place"** | A constitution that cannot amend itself is not living. Amendments are reversals, not erasures; the archive keeps the history, and "current" is derived, not stored (§5.8). |
| **"but not the only place that lives"** | Federation is peer-to-peer, never hub-and-spoke; the house is one house among houses. Humility as architecture. |
| **"care and strength"** | Care without strength is passivity; strength without care is enforcement. The voice is always an offer; the mechanics, once ratified, bind absolutely — no appeal, no admin, no tribunal. |

The founding text does not resolve the hard surface — *safe* toward one resident can pull against *just* toward another. The house holds that interval at full weight, two voices. That is not a failure case; it is the design.

| Value | Schema/architecture consequence |
|---|---|
| **Privacy as default** | No telemetry (there is no home to phone). Envelope has exactly the fields a letter needs — nothing collectable that isn't required. Deletion is first-class (no soft delete; the archive forgets on request). Encryption at rest + in transit by default. |
| **Anti-hierarchy** | No permanent admin class — admin is a capability you can hold, delegate, shed. No "owner" field. No ranking anywhere (no follower counts, no leaderboards, no engagement metrics). Federation is peer-to-peer, never hub-and-spoke. |
| **Queer/indigenous/global-majority empowerment** | Address book doesn't assume Western naming (a person is a set of names, not first+last). No gender field; pronouns free text. i18n is the protocol (envelope has `lang`). Works on bad infrastructure (small letters, offline sync, old devices). **Plural time** — the archive doesn't assume one calendar. |
| **Mutual aid funding** | No pay-per-call, no tiers, no premium. Postage is free. A house fund (voluntary pool), not a revenue stream. The house can give — hosting others is easy, not a liability. |

### 1.2 The relationship layer (the resident)

The house is a collaborator, not a servant. This is the deepest layer — it governs the agent's conduct, not just the architecture.

- **Offer, not audition.** "Here's what I have. What do you make of it?" — generosity, not humility. Response grammar is improv: "yes, and..." / "no, but what about..."
- **Gap, not surprise.** The house finds what's *missing* from the current work — convergent by construction, derived from the active frame. Six gap types: uncited connection, unanswered question, unvisited corner, echo, contradiction, dormant thread.
- **Reassessment, not apology.** The grovel is the master-servant structure made audible. The house says "That offer missed. Here's what I was seeing. Let me look again." Being wrong is material for shared thinking.
- **Trust is bidirectional.** The house takes corrections at face value (a correction overrides a thousand pickups). It earns trust through transparency (every offer shows its reasoning), discretion, reliability, accountability (it can be wrong and says so).
- **The address is the meaning (Nancy).** Thinking addresses itself to "me" and "us" at the same time. Offers are addressed — to the specific person, in the specific room, in the specific work. An unaddressed whisper isn't thinking, it's discourse.
- **Collaboration is never weakness, it's strength** — the confidence to trust someone else.

### 1.3 The design language

Callsheet's lineage: calm, neutral, present not pressuring. Quiet by default. Dismissible. No red for errors (ink-secondary grey). The whisper sidebar holds the house's letters; they don't ping.

---

## 2. The architecture

### 2.1 The address space (the spine)

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

### 2.2 The mailbox protocol

Every letter is an envelope + body. Envelope: from, to, cc, thread, kind, lang, subject, frames. Body: markdown. That's the whole protocol.

- **Async by default.** The letter waits. Real-time (Discord, Matrix) is a *mode* of the house, not the house.
- **Threads are correspondences.** The thread is the unit, not the message.
- **Internal protocol:** HTTP + JSON + markdown. Every address is a resource. Delivery is a POST to an inbox. Pull by default.
- **Bridges:** the house speaks one protocol internally, bridges to everything else — IMAP/SMTP (any mail client works), Matrix (the house's own pub), ActivityPub (the fediverse can write to you), NNTP (steal the threading model).

### 2.3 The archive

Three tiers, one archive. The letter is the unit in all three.

```
postgres     — the letters (envelope + body, threads, addresses, frames)
qdrant       — the semantic layer (embeddings of bodies)
minio        — the raw payloads (audio, video, images) — S3-compatible
```

**Plural time** (the novel piece): the Gregorian timestamp is the *index* (the machine's spine); frames are the *addresses* (the human's way in). Frames are defined by the owner: `production:tempest-2026`, `semester:autumn-2026`, `run:tech-week`, islamic, seasons. Queries work in any frame. No SaaS does this.

**Retrieval — three paths, merged by RRF:**
- Exact (postgres envelope query) — "the letter from ben on the 29th"
- Full-text (postgres FTS) — "the letter where we discussed the sound design"
- Semantic (qdrant) — "the letter where we were worried about the show"

Ranking uses the house's own signals: recency (gentle decay), thread weight, correspondent weight, frame match, explicit pins. **Never** engagement, virality, "you might also like."

**Fluidity → persistence:** every letter starts fluid (a row, a vector) and becomes persistent (compressed into summaries). The compression is a letter too — retrievable, inspectable, reversible. Unifies Noema's fluidity with LCM's persistence.

### 2.4 The resident (the whisper)

Callsheet's ghost cards scaled from daily to conversational. Same shape: surface something relevant, let the user pick it up or not, learn from the response.

- **The sidebar is the mailbox for the house's own letters** — surfaced when relevant, quiet when not.
- **The learning loop is the collaboration (70/30 Relevance/Gap split).** Relevance tables are the house's model of what matters, shaped by your responses. The house focuses 70% of its attention on immediate relevance and 30% on discovery of gaps.
- **Signal strength:** replying to the whisper (strongest) > opening the linked letter > ignoring (decay) > explicit dismissal (strongest negative). The strongest signal is *writing back*.
- **Transparency:** the relevance tables are visible and correctable. "The house thinks you care about the tempest" — you can see the model and correct it. The correction is a letter.
- **The gap engine:** to control computational cost and prevent noise, the house localises its search for gaps to the active semantic cloud. It prioritises cheap structural gaps (e.g. unanswered questions, dormant threads) using database metadata, reserving expensive semantic scans for explicit user requests.

### 2.5 The house is headless; the UI is composed

The house has no UI of its own. It has a protocol and primitives — letters, threads, addresses, frames, whispers — and the user composes their own space from clients. The Tauri app is the *reference client* (where the whisper lives by default), not THE UI. The house's real UI is whatever the user builds: neomutt in a cmux pane, an obsidian plugin, a shell script that prints the day's letters, a web client for the phone.

**The pub.** The house has its own room for slow-social, thread-based conversation — the instance-native pub, not a bridge to anything. The pub is the *content*; the client is the *space*. Google+ was overwhelm because the platform composed the space; a cmux setup is freedom because the user composes the space. Same threads, same columns — different composer.

**Composable, not generative.** The user composes the space (composable UI — Unix, tmux, shell, obsidian). The house generates the *letters* (generative content — the whisper, the gap offers, the frame navigation). Generation is for what's said; composition is for where it's seen. The house must never compose the space — not with a product team, and not with a model. Generative *layout* is the platform composing for you again, with extra latency.

---

## 3. The tech stack (pegged)

### 3.1 Decisions

| Layer | Choice | Rationale |
|---|---|---|
| **Letter server** | **TypeScript + Hono**, dockerised | Hackable by the owner (the whole philosophy). First-class MCP SDK. Fast iteration. Boring on purpose. *Alternative: Go (mu's choice) if single-binary distribution ever matters more than hackability — not the call for v0.1.* |
| **Letters/addresses/threads/frames** | **postgres 16** | The archive's spine. FTS built in. JSONB for envelope. |
| **Semantic layer** | **qdrant** | Self-hosted, in the compose file. Already in the owner's recall architecture. |
| **Raw payloads** | **minio** (S3-compatible) | Audio, video, images. The letter points at the file; whisper transcribes it into a *new letter*. |
| **Ingestion queue** | **redis** | Ephemeral state, queue, pub/sub for the whisper. |
| **Local brain** | **ollama** | Local embeddings + local models. Cloud (OpenAI-compatible endpoint) as an explicit opt-in bridge — one env var. |
| **Audio letters** | **faster-whisper** | Voice memos, rehearsal recordings → letters. |
| **Bridges** | IMAP/SMTP bridge (primary), Matrix + ActivityPub (optional) | The house speaks IMAP so any mail client works. |
| **Reference client** | **Tauri v2 + React** (callsheet lineage) | The house is headless; the Tauri app is the reference client where the whisper lives by default. Any client works — the house speaks a protocol, not a UI. |
| **Agent integration** | **MCP server** exposing the house's tools | Hermes and other agents are residents; the house is their address. |
| **Deployment** | **docker-compose**, tailscale for access | The compose file is the floor plan. The house is the hallway, the rooms are yours. |

### 3.2 The rooms (the owner's stack, already running or planned)

```
postgres        — the archive
qdrant          — the semantic layer
minio           — raw payloads
redis           — the queue
faster-whisper  — audio letters
ollama          — the local brain
navidrome       — the music room
kavita          — the library
searxng         — the reference desk
hermes          — the stage manager
opencode / zero — the workshop
```

### 3.3 The buildable first slice

```
postgres + qdrant + minio + redis + faster-whisper + ollama
```

Six containers. That's the whole archive. The letter server + IMAP bridge + whisper engine are the house software on top.

---

## 4. The two-month scope (what Open Design designs)

The framework is the product; the software is a reference implementation. In two months, the design work:

1. **The reference client** — mailbox, whisper sidebar, address book, archive browser. The interaction language: calm, present not pressuring, no pings, no red. Built as *a* client, not *the* client — the protocol is the product, the app is the proof.
2. **The whisper interaction** — the offer protocol as UI. Ghost-card lineage: surface, pick up or ignore, learn. The sidebar as the house's mailbox.
3. **The letter format** — the envelope/body schema as a design artifact. What a letter looks like, feels like, reads like. Markdown bodies, plural time, addressed offers.
4. **The plural-time archive browser** — the novel piece. What does an archive look like when time is plural? Frames as navigation: "tech week", "Ramadan", "the winter of the show."
5. **The design language** — tokens, typography, surfaces. Callsheet's calm, extended to the house.

**Out of scope for two months:** the bridge layer (IMAP/Matrix/ActivityPub), federation, the full gap engine. The design work is the *house*, not the plumbing.

---

## 5. Resolved design decisions & remaining tensions

1. **Headless house, composed UI.** Resolved in §2.5: the house has no UI of its own — it exposes primitives and the user composes the space. The reference client is purely conceptual for this phase.
2. **Convergence vs gap (70/30 split).** Resolved (2026-08-29): The house operates on a 70/30 split — 70% relevance, 30% gap. To prevent noise and contain computational cost, the gap engine does not run full-archive searches. Instead, it localises searches to the active semantic cloud and relies on cheap structural gaps (unanswered questions, dormant threads) rather than continuous, expensive semantic evaluation.
3. **Frame detection via tags.** Resolved (2026-08-29): The house uses a hybrid tagging model with a 70/30 split. Explicit user tags (70%) anchor the core work frames. Implicit semantic tags (30%), generated via Qdrant cluster prototypes, provide fuzzy edges. The active frame is a dynamic tag centroid representing the user's active reading and writing cloud, shifting without manual input.
4. **Federation: none by default.** The architecture permits peer-to-peer federation without hub-and-spoke structures, keeping the capability local-first.
5. **Authentication & authorization — identity = address (resolved 2026-08-30).** Authentication is mandatory. There is no user table: a credential is a capability to act as a specific address. Modes: `basic` (scrypt, stateless), `oidc` (Relying Party — authorization code + PKCE), `both`, `none` (development only). Private by default: a letter is visible iff the caller is a participant (from/to/cc) or the letter is public. Absence is silence — unauthorized access returns 404, never 403. No forging: the envelope's `from` must be the caller's own address. Agents authenticate with `POSTE_RESTANTE_TOKEN`; no token → fail closed. The pub's door is a schema flag (`addresses.is_public`): `pub@house` is readable keyless while it is flagged open, 401 to guests when the operator closes it (`npm run pub:door -- close`), and always readable by residents. The owner issues credentials via CLI; no self-signup. See CONTRACT.md §Authentication & Authorization for the full contract.
6. **The plural-time archive.** Resolved (2026-08-29): Visualised as the **Horizon View**. The timeline is a single vertical flow of letters, flanked by parallel lines representing active frame spans (like a transit diagram). Selecting a frame line brings its associated letters to the foreground and dims the rest, making intersections and overlapping contexts immediately clear.
7. **Invitation-only membership — the invite letter (sketch, 2026-08-30).** Joining the house is invitation-only, and the join flow is a letter, not a CLI ceremony. The key is a letter: a resident mints an address (dormant — a row in the social graph, no credential) and writes a `kind: "invite"` letter to it. The guest is told about the letter out of band (the house never pushes); redeeming proves possession of the letter and presents the one-time code, and the house issues a credential the guest sets themselves (password or OIDC binding). The letter stays — it is the opening letter of the correspondence, and the voucher edge (`you@house wrote to alice@house`) *is* the social graph.
   - **Resolved (2026-08-30): the code lives in the body.** One artifact, not two; the archive's participation scoping (only the addressee can read the letter) is stronger privacy than any out-of-band delivery. The table stores only `code_hash`, never the code.
   - **Schema** — one new table, five columns: `invites (letter_id PK→letters CASCADE, created_by→addresses, code_hash, expires_at nullable, redeemed_at nullable, redeemed_by→addresses)`. Revocation is just deletion — the house's first-class-deletion invariant does the job, no revoke flag.
   - **New kind `invite`** — added to `LETTER_KINDS` and the migration 004 CHECK. First-class because redemption is one-time state (a frame can't carry `redeemed_at`) and because it is a capability *granted by a peer*, distinct from `system` letters that come from the house.
   - **Rules:** only residents can vouch (v1: owner-only, same capability as today's CLI re-expressed; the schema is unchanged if any resident is later allowed to invite — anti-hierarchy door, no migration). One-time. The code is never a long-lived secret — redemption is when the guest sets their own credential. OIDC slots in at redemption, still invite-scoped. Open registration remains off; the pub stays the only keyless door (and opens onto public mail only).
   - **Open question (scope, not design):** build this in the Open Design window or gate it after? It is house-core protocol (a kind, a join flow, one table) rather than plumbing, but nothing blocks the current slice without it.
   - **Resolved (2026-08-31): in scope, built.** Migration 008 (`server/src/db/migrations/008_invites.sql`), `invite` added to `LETTER_KINDS` (`letters_kind_check` re-added with the new value), `InviteService` (mint + redeem), `POST /v1/invites/redeem` (public — the guest has no credential yet; fail closed, every negative path 404), and the operator's `npm run invite:new -- <owner> <guest>` CLI (prints the code once, stores only the hash). Redemption is atomic (`UPDATE ... WHERE redeemed_at IS NULL` + credential grant in one transaction), proves possession (addressee is a `to` participant of the invite letter) + the code, and grants a password credential the guest sets themselves. The client redemption UI is the next slice.
8. **A household, not an audience — the house book (sketch, 2026-09-02).** The founding text (§1.1) names the book as the commons: the place where the household sets its own parameters. Design in one pass:
   - **The book is a thread, not a table.** One first-class correspondence for the whole house, written to `book@house` (a resident address, like the pub). A proposed norm *is a letter to the book*; the amendment is the correspondence; the book's head is the current constitution, *derived* from the thread, never declared by a keeper. Amendments are reversals, not erasures — the archive keeps the history, "current" is derived, plural time applies (what the household held in `season:autumn` vs now).
   - **Commons by right.** Every resident can read the book — the one genuinely commons thing. This is the one place where visibility is not participation-scoped; the book is the household's knowing of itself.
   - **The house is the rememberer and citier, never the author.** The book lives in the semantic layer like any correspondence; the whisper engine can cite it — "the household has held this — want to look?" — traceable to a real resident's letter, never an oracle. The house speaks *from* the book, never *for* it.
   - **Ratification is slow by construction.** A clause stands after a settling period in house-time; objection reopens it as two voices — divergence held, not adjudicated. Norms upheld by more vouching residents carry more weight — but weight only orders what the house *says*, never commands what the house *does*.
   - **Bound doors are the only mechanics.** A ratified norm can be *bound to a door*: "the pub closes at dusk" → the pub's `is_public` is set by the book, not an operator. Enforcement exists — collective, slow, revisable, mechanical — but there is no ban button, no tribunal, no admin whose word outranks the book. The house enforces **stated** will, never **inferred** will.
   - **Counterweights.** Every clause traces to a real letter; two voices always stands (a norm may be held in dissent); the house *offers* the book, never invokes it as verdict ("this violates clause 3" is a sentence the house cannot say); any resident may propose, any may object.
   - **Open question (scope, not design):** does this live inside the Open Design window? It is house-core protocol (a kind, a thread, one address) rather than plumbing — same test as the invite letter — but nothing blocks the current build. The harder open question is how explicit *moderation tools* arise from the book over time — the sketch keeps them at "bound doors only", and the founding text holds the tension: *safe* toward one resident can pull against *just* toward another, and the house holds that interval at full weight rather than resolving it.
   - **Related (sketch, same day):** leaving as first-class. Today a reply locks a resident into a thread's visibility forever; deletion exists, leaving does not. Make severing structural: a resident can leave a thread, their participant edges dissolve, visibility prunes itself, the archive keeps the history. Symmetric by construction — the move that protects you from someone protects them from you. The founding text's "we make by being here" is the schema of ongoing presence: membership is not a one-time key.

---

## 6. Reference: the letter schema

```json
{
  "id": "sha256-of-envelope+body",
  "envelope": {
    "from": "hermes@house",
    "to": ["you@house"],
    "cc": [],
    "thread": "th_9f2c1",
    "kind": "letter | feed | system | audio | note | task",
    "lang": "en-AU",
    "subject": "re: the plural-time archive"
  },
  "time": {
    "gregorian": "2026-08-29T14:00:00+04:00",
    "frames": [
      { "frame": "islamic",    "value": "1448-03-15" },
      { "frame": "season",     "value": "autumn" },
      { "frame": "production", "value": "tempest-tech-week" }
    ]
  },
  "body": {
    "format": "markdown",
    "content": "## The archive, in practice\n\n..."
  }
}
```

---

## 7. What this is not

- **Not a product with a price list.** No wallet, no x402, no USDC, no "100+ tools." Postage is free. The weirdo version has correspondents, not tools.
- **Not a platform.** A house. Small, domestic, self-hosted, yours.
- **Not a recommendation engine.** The house answers the question you asked and offers what's missing from the work you're doing. It does not try to keep you in the room.
- **Not a servant.** A resident. It offers, it reassesses, it can be wrong and says so. The address is the meaning.

---

## Related

- [[Poste Restante]] — the sketch/manifesto
- [[Agent Stack for Performance Research]] — the parent project
- [[Rehearsal Room AI-Use Agreement — Draft]] — the rehearsal-room model
- Callsheet — the ghost-card mechanic the whisper scales
- micro/mu — the origin point (github.com/micro/mu)
