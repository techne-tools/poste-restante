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
| **"a living place"** | A constitution that cannot amend itself is not living. Develops are reversals, not erasures; the archive keeps the history, and "current" is derived, not stored (§5.8). |
| **"but not the only place that lives"** | Federation is peer-to-peer, never hub-and-spoke; the house is one house among houses. Humility as architecture. |
| **"care and strength"** | Care without strength is passivity; strength without care is enforcement. The voice is always an offer; the mechanics, once ratified, bind absolutely — no appeal, no admin, no tribunal. |
| **Consent-forward (2026-09-02)** | No and yes are equally significant. The book's vocabulary is the household's own — offer, develop, stop, support, set aside — not parliamentary. **Stop is a safe word, solidly grounded throughout the house**: a stop reopens a clause as two voices and contested never stands; the whisper's dismiss is a stop on the house's own voice; leaving is the structural stop on a thread (the move that protects you from someone protects them from you). The house never infers a no from silence, never treats a yes as permanent. |

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
   - **The book is a thread, not a table.** One first-class correspondence for the whole house, written to `book@house` (a resident address, like the pub). An offered norm *is a letter to the book*; the develop is the correspondence; the book's head is the current constitution, *derived* from the thread, never declared by a keeper. Develops are reversals, not erasures — the archive keeps the history, "current" is derived, plural time applies (what the household held in `season:autumn` vs now).
   - **Commons by right.** Every resident can read the book — the one genuinely commons thing. This is the one place where visibility is not participation-scoped; the book is the household's knowing of itself.
   - **The house is the rememberer and citier, never the author.** The book lives in the semantic layer like any correspondence; the whisper engine can cite it — "the household has held this — want to look?" — traceable to a real resident's letter, never an oracle. The house speaks *from* the book, never *for* it.
   - **Ratification is slow by construction.** A clause stands after a settling period in house-time; objection reopens it as two voices — divergence held, not adjudicated. Norms upheld by more vouching residents carry more weight — but weight only orders what the house *says*, never commands what the house *does*.
   - **Bound doors are the only mechanics.** A ratified norm can be *bound to a door*: "the pub closes at dusk" → the pub's `is_public` is set by the book, not an operator. Enforcement exists — collective, slow, revisable, mechanical — but there is no ban button, no tribunal, no admin whose word outranks the book. The house enforces **stated** will, never **inferred** will.
   - **Counterweights.** Every clause traces to a real letter; two voices always stands (a norm may be held in dissent); the house *offers* the book, never invokes it as verdict ("this violates clause 3" is a sentence the house cannot say); any resident may propose, any may object.
   - **Open question (scope, not design):** does this live inside the Open Design window? It is house-core protocol (a kind, a thread, one address) rather than plumbing — same test as the invite letter — but nothing blocks the current build. The harder open question is how explicit *moderation tools* arise from the book over time — the sketch keeps them at "bound doors only", and the founding text holds the tension: *safe* toward one resident can pull against *just* toward another, and the house holds that interval at full weight rather than resolving it.
   - **Resolved (2026-09-02): in scope, built.** Migration 012 (`server/src/db/migrations/012_book.sql`), `clause` added to `LETTER_KINDS`, `BookService` (`server/src/book/`), `GET /v1/book` (the derived head), `GET /v1/book/threads/:id` (the correspondence), `POST /v1/book` (the act — the act IS a letter), MCP tools `read_book`/`read_clause`/`act_on_book`, and the reference client's **Book** surface. The book is a thread, not a table: an offered norm is a letter to `book@house`; the head is *derived* from the thread (the `clauses` table is the rememberer's cache — wiping and re-deriving yields the same head). Roles are stated will in the body's frontmatter, and the vocabulary is the household's own — **consent-forward, not parliamentary** (2026-09-02): `offer` (opens a thread; may carry `reverses:` and `binding:`), `develop` (new text, fresh settling, stops cleared, supports persist), `stop` (a safe word — reopens as two voices, contested never stands; "i don't want this to happen any more"), `support` (distinct per resident; orders what the house *says*, never what it *does*), `set aside` (clears the stop; clearing the last restarts settling — shelved, not destroyed). Ratification is slow by construction: a clause stands after `BOOK_SETTLING_DAYS` (default 7) with no open stop. A standing reversal reverses its target — derived cross-thread, never declared. **Bound doors are the only mechanics:** a standing clause may bind `pub@house.is_public`; the door is derived from the book (latest standing binding wins; when the last binding is reversed the door returns to its default open), and the book only writes the door when a binding's state changed — it never fights a manual operator state while no binding stands. Commons by right: every resident reads the book; it is NOT a keyless door — guests get 401. Privacy checklist passed; 156/156 server, 43/43 client; browser E2E proved the full arc (offer → support → stop → set aside → settle → door bound → "CLOSED — the pub's door, bound by the household").
   - **Related (sketch, same day):** leaving as first-class. Today a reply locks a resident into a thread's visibility forever; deletion exists, leaving does not. Make severing structural: a resident can leave a thread, their participant edges dissolve, visibility prunes itself, the archive keeps the history. Symmetric by construction — the move that protects you from someone protects them from you. The founding text's "we make by being here" is the schema of ongoing presence: membership is not a one-time key.
   - **Resolved (2026-09-02): in scope, built.** Migration 013 (`server/src/db/migrations/013_leaving.sql`), `leave`/`join` added to `LETTER_KINDS`, `ParticipationService` (`server/src/participation/`), `POST /v1/threads/:id/leave` and `/join` (the act IS a letter — addressed to the thread's current participants, the archive keeps the history), MCP tools `leave_thread`/`join_thread`, and the reference client's left state ("you have left this correspondence" — calm, with a rejoin action). Participation is *derived*: the `thread_participation` table is the rememberer's cache (wiping and re-deriving from the letters yields the same rows; the upsert guard refuses out-of-order writes). Visibility prunes itself: `isVisibleTo`/`visibleToSql`/the whisper's `VISIBLE_TO`/the gap engine's detection queries all gain the derived-participation limb — a leaver gets 404 (never 403), the whisper stops offering the thread, and gaps are not even created for it (convergent by construction). The book is exempt: clause threads are commons by right — you cannot leave the household's knowing of itself (400). Symmetric by construction: the same move, available to everyone, protects everyone. Privacy checklist passed; 172/172 server, 43/43 client; integration tests prove the full arc (leave → 404 → whisper stops → gaps stop → rejoin → restored) plus the negatives (guest 401, non-participant 404, book exempt).
   - **Resolved (2026-09-02): in scope, built.** The whisper's citation of the book (migration 014, `server/src/db/migrations/014_whisper_citation.sql`). When the house offers a gap, it may also cite a clause the household has already held that bears on the matter: the gap pass embeds each whisper's own summary (its framing, not the raw letters), searches the semantic layer, and — if a STANDING clause shares ground above the citation threshold (0.5, deliberately below the connection threshold — a pointer, not a claim of identity) — the whisper carries `citedClause`/`citedExcerpt`. The client renders it quietly under the whisper: "the household has held this — want to look?" with the excerpt and a link that lands in the book with that clause open. Only standing clauses are citable — "the household has held this" means settled knowing; a proposed clause is still before the household, a contested one is held in dissent, a reversed one is no longer held. Privacy as schema: the book is commons by right, so citing a clause leaks nothing — no new visibility limb is needed. The citation is derived, like everything else: wiping the columns and re-running the pass yields the same citations. Privacy checklist passed; 181/181 server, 43/43 client; integration tests prove the arc (standing clause → citation fires; no shared ground → no citation; proposed clause → not citable).
9. **The living pass — the engine breathes (sketch, 2026-09-04).** The first plumbing slice after the window closed. The six gap types are built and the citation pass is live; what is missing is the machinery around the detector: nothing runs unless a caller asks, and the learning loop is recorded but never read. Two movements, one slice:
   - **The scheduled pass.** `detectGaps(address)` is on-demand only (`POST /v1/whisper/gaps`, MCP `detect_gaps`). An in-process interval (config `GAP_PASS_INTERVAL`, default 6h) runs the existing detector per resident address. It only *stores* — the resident still pulls the GET, so presence-not-pressure holds: the house breathes, it never interrupts. Idempotent (`ON CONFLICT DO NOTHING`), restart-safe (missed passes self-heal; no backfill), scoped per address (only residents with a credential; the house never scans dormant invite addresses). Logs stay event-name-and-count only.
   - **Convergence ordering (SPEC §5 #2, 70/30 — the loop finally read).** `list`/`listUnread` sort by `created_at DESC` only, yet the loop is recorded (`opened_at`/`replied_at`/`dismissed_at`). Surface what the resident actually engages with: replied → opened → recency, dismissed excluded from unread (already true), a deterministic signal sort — no migration, the columns exist. The ordering *is* the 70% relevance; the detector stays the 30% gap. The house's priorities are explainable: the signal columns are visible in the reasoning, and the sort is deterministic.
   - **Deferreds folded in (REVIEW-8):** the `auth:add` CLI readline quirk (piped stdin silently eats the password prompt — fix the operator tool) and the deployment-reality docs pass (ARCHITECTURE/AGENTS still promise six containers; the host is native postgres/qdrant/ollama — the docs are aspirational, the house is native).
   - **Resolved (2026-09-04): in scope, built.** `GapScheduler` (`server/src/whisper/scheduler.ts`), `GAP_PASS_INTERVAL_MS` (default 6h, 0 disables), wired into both `main.ts` and `mcp/main.ts`; `list`/`listUnread` sort replied → opened → recency; the `auth:add` TTY guard; the deployment-reality docs pass. Test-count head: 189/189 server.
10. **The SMTP door — the house meets real mail (sketch, 2026-09-04).** The bridge layer, movement A of three. The house speaks one protocol internally (CONTRACT.md); a bridge translates. The first door is inbound only: the house accepts SMTP on a local submission port, authenticates the sender as a resident, and ingests the mail as a letter through the same pipeline, same idempotency, same privacy. Movement B (IMAP read-side) is the thin-ecosystem risk and stays out; movement C (external sync) needs real credentials and deployment reality — both are flagged, not built blind.
   - **The anti-forging invariant is unchanged.** The envelope `from` is the SMTP-authenticated address — a different `MAIL FROM` is 550'd before DATA. The house never accepts a letter the caller cannot own (the HTTP face's no-forging rule, carried across the new transport).
   - **Privacy as schema, unchanged.** Only residents can post — SMTP AUTH against the house's own credentials; no anonymous relay (530 without auth, 535 with bad auth); nothing is stored on either negative. The recipient address materialises like any letter's `to`; visibility stays participant-derived. A letter is private iff its participants are private — mail changes nothing.
   - **The translation is the bridge.** RFC5322 → the letter contract: `Date:` → gregorian; text/plain (charset + quoted-printable/base64 decoded) → markdown body; `X-House-Thread:` header → continue that thread; else `re:` subject match against the recipient's recent correspondence → continue; else a deterministic new `th_smtp_` thread. No X-headers are honoured beyond the thread one.
   - **Presence not pressure.** The door accepts mail; the whisper and reply-tracking behave exactly as for HTTP letters (`deliverLetter` is the shared seam). Nothing pushes, nothing pings.
   - **Config.** `SMTP_ENABLED=1` (default off — the door is closed until opened), `SMTP_BIND` (default `127.0.0.1:2525`). The bridge refuses to start when auth is disabled (`AUTH_MODE=none` → fail closed).
   - **Resolved (2026-09-04): in scope, built.** Movement A — inbound SMTP. `server/src/bridge/smtp.ts` (`startSmtpBridge`, `translateMail`, `normalizeSubject`, `deterministicThread`, `parseBind`), `server/src/bridge/threads.ts` (the re:-subject seam). `SMTP_ENABLED` (default off), `SMTP_BIND` (default `127.0.0.1:2525`); refuses to start with `AUTH_MODE=none`. Wired into `main.ts` through the shared `deliverLetter` seam. Dependencies: `smtp-server` + `mailparser` (both maintained by the nodemailer project; no telemetry). 207/207 server. The IMAP read-side, external sync, and outbound remain deferred as sketched.
11. **The read-side research pass — movement B's verdict (resolved 2026-09-04).** The IMAP read-side was flagged at the gate as the thin-ecosystem risk; the pass was scoped to survey and decide build-or-cut, not to write code. Verdict: **build movement B as an adapter over an external IMAP server — do not attempt an in-process JS IMAP server.**
    - **Ecosystem (surveyed 2026-09-04):** the pure-JS server foundation is dead. `imap-server` last published 0.0.1 (2022-06), `jmap-server` 0.0.2 (2022-06), `jmapjs` delisted (404). Nothing maintained to build RFC-depth mailbox/UID/flag state on. The mature servers are C/C++/Rust: Dovecot (20+ years production) and **Stalwart** (Rust; 14.5k★, last commit days before the pass; one binary speaking IMAP + JMAP + SMTP + CalDAV + CardDAV; ~2.4× less memory than Dovecot, 3–13× faster FTS per a 2025 head-to-head). Stalwart is the sidecar candidate: one brew-installable native binary, no Docker (deployment-reality: the host is native), port in the 21000 range per AGENTS convention.
    - **The client that forces the read-side: Spark.** Spark Desktop (the user's mail client) only adds custom accounts via **manual IMAP setup** (`Set Up Account Manually` — "the way you can set up IMAP accounts only"); there is no SMTP-only custom account, and SMTP-only accounts are not a Spark concept. The Proton Mail Bridge precedent (a local process exposing IMAP+SMTP that Spark attaches to) is exactly the house's intended shape. Consequence: **an SMTP-only resident client cannot exist in Spark — movement B is required for Spark to be a resident client, not optional.**
    - **Privacy shape is unchanged — schema-derived.** The adapter presents per-credential IMAP accounts; an IMAP user sees only mailboxes/letters their participant edges qualify for (the same `isVisibleTo` limb the HTTP/MCP faces use). One credential = one mailbox view; no global read is possible because the read query is the derived-participation query.
    - **The real work is mailbox materialisation, not protocol.** Mapping the letter archive (threads, plural time, participant edges) onto IMAP's fixed-shaped world (folders, UIDs, flags, SEARCH) is the design problem: thread → folder? plural-time frames → virtual folders? What does SEARCH mean over the semantic layer? That design precedes any code, in the house's design-first order. Building a maintained-protocol sidecar + adapter (a second translation seam, same shape as the SMTP door) is bounded; a from-scratch in-process IMAP server is a second project.
    - **Action record:** Stalwart = candidate sidecar for movement B — as a **container image** (`stalwartlabs/mail-server`) on the Docker homelab stack, host port in the free 21xxx range (corrected 2026-09-04: not a brew install — see #14). In-process JS IMAP server = **cut**. Spark handoff: after movement B exists, the user adds the account manually in Spark's UI (IMAP `127.0.0.1:<port>`, SMTP `127.0.0.1:2525`) — Spark's account store is Electron/IndexedDB, not seedable from outside; the UI step is the honest path.
12. **Mailbox materialisation — movement B's design (sketch, 2026-09-04).** The map from the letter archive (threads, plural time, participant edges) onto IMAP's fixed-shaped world (folders, UIDs, flags, SEARCH). Design first — this precedes any code, in the house's order. The read side is the reverse translation of the SMTP door: the house's protocol is the truth; a mailbox is a *view* the house maintains, derived like everything else.
    - **The shape: mailbox == a letter's visibility set, not a copy store.** The IMAP server (Stalwart sidecar) holds *messages, not letters* — the archive remains the archive, the mailbox is a materialised view of the letters the authenticated user can see (`isVisibleTo`/`visibleToSql`, the same derived-participation limb the HTTP/MCP/whisper/gap faces use). The adapter reads the archive and **syncs the view** into the sidecar's store (push-style mirroring on the house side — the house writes, the client pulls; presence not pressure holds because the client initiates every IMAP connection). Deleting a message in IMAP is a view operation (the archive's first-class deletion stays an explicit, separate act — absent an explicit resident delete, the letter survives).
    - **Folders are frames, not threads — the plural-time answer.** One folder per active *frame* the user participates in (`production:tempest-tech-week`, `season:autumn`) plus an **Inbox** (the resident's mailbox: frames empty → Inbox), an **Archive** (all visible letters), and **Sent** (letters the resident sent). A letter appears in exactly one frame folder (its most recent active frame; precedence: newest frame with letters) *and* Archive — duplicates across folders are the house's plural-time truth wearing IMAP's clothes. Threads are NOT folders: IMAP's native threading (REFERENCES/Message-ID headers) reconstructs conversation grouping client-side, and the house can emit synthetic `References`/`In-Reply-To` headers on materialisation so Spark/neomutt group the thread the house's way without the house making folders per thread (folder-per-thread would explode the mailbox as threads grow).
    - **UIDs are derived, not declared.** The mailbox is a derived view, so message UIDs must be stable across syncs and resyncs: UID = a deterministic function of the *letter id* (sha256 of envelope+body → the existing letter hash). The house can wipe and re-sync the mailbox and every client sees the *same* UIDs — same derivation principle as clauses and thread_participation ("wiping and re-deriving yields the same rows"). Nothing about the sidecar's internal numbering is trusted; the adapter re-derives on every pass.
    - **Flags are the learning loop, read back through IMAP.** IMAP's flags map onto the house's recorded signals: `\Seen` ⇄ `opened_at`, `\Answered` ⇄ `replied_at`/thread replied, `\Flagged` ⇄ pinned (pinned letters already rank higher in retrieval — SPEC §5 #9's convergence ordering surfaces through Spark's star). The sync is *bidirectional on flags only* — the house reads flag state back and updates the signal columns, so "the loop finally read" (SPEC §5 #9) is visible in a mail client. Bodies are never sync-back; the archive is the truth, flags are the only client-writable surface (and the only thing the client may mutate, privacy-schema-clean: a client cannot write a letter into another user's view).
    - **SEARCH is a house question, not a sidecar index.** IMAP SEARCH maps on to the house's retrieval seam (thread, participant, frame — and the semantic layer where the client allows). v1: the adapter handles the structural subset (date, subject, to/from, keyword) and returns ids; semantic SEARCH over the archive is a flagged extension, not the core. No global read is possible — every SEARCH is scoped by the derived visibility the same way every other read is.
    - **Provisioning = one account per credential.** A resident connects to the local IMAP port with their house address+password; the sidecar authenticates, the adapter resolves the credential to the derived view. One credential = one mailbox view; no admin inbox, no global read (the anti-hierarchy invariant holds: capabilities, not admin roles). The house does not issue credentials for addresses it cannot prove party — fail closed (a guest sees nothing, per absence-is-silence).
    - **The hard part is the sync, not the protocol.** The adapter is a state machine over "what the archive says" vs "what the sidecar holds" — re-sync on start, delta on every letter stored, flag read-back on interval. The `onStored` hook (the same seam the outbound seam will use) is where sync is triggered. This is a bounded engineering slice; the from-scratch in-process IMAP server was already cut (#11).
    - **Open questions for the build pass (explicit — none block this sketch):** (a) does the Stalwart-sidecar path need its own lightweight store per credential, or can the sync write into Stalwart's normal account store without duplicating house credential state? (the house's auth remains authoritative; the sidecar's store is view-only). (b) IMAP's push story (`IDLE`) — presence-not-pressure says the client pulls; IDLE is a pull-shaped feature (server holds the connection while the client waits), so it can be supported without violating the invariant, but the adapter's first pass omits it. (c) what does `\Deleted` + EXPUNGE mean in a view? (probably: nothing in v1 — the view re-materialises the letter — pending the explicit-deletion slice.)
    - **Resolved (B1, 2026-09-04): the pure engine.** `server/src/bridge/mailbox.ts` — the deterministic mappings the B2 sync layer will drive: `uidForLetter` (first 32 bits of the letter sha256 — same letter, same UID, every sync), `frameFolder` (`name:value`), `folderForLetter` (the letter's own frame order is the "newest frame with letters" precedence; the resident's active frames are a membership test, never an ordering; else Sent for the writer, else Inbox; Archive is a caller-composed constant), `translateToMailbox` (stable `Message-ID: <letterId@house>`, synthetic `References: <threadId@house>`, null `In-Reply-To`, plain-text body via the existing markdown extractor, `MailFlagState` for the learning loop — `\Seen`⇄`opened_at`, `\Answered`⇄`replied_at`, `\Flagged`⇄pinned). No visibility limb — the caller hands it already-visible letters; it cannot leak one it is never given. 17 hermetic unit tests incl. the wiped-and-re-derived UID-stability property; 162/162 server unit, 79/79 integration, 43/43 client, typecheck + build. **Next: the B2 sync layer** (sidecar + imapflow: resync on start, delta on `onStored`, flag read-back; `IDLE` omitted v1; `\Deleted`+EXPUNGE = nothing in v1).
13. **The outbound seam — movement D (sketch, 2026-09-04).** Movement C (external sync — fetching mail from real providers into the archive) stays out as sketched ($#11); this entry is the *reverse* of the SMTP door: a resident writes a letter addressed to an external address, and the house carries it out. Design-first, then built in the same slice — the outbound seam is small and composes with the pipeline's single-write-path hook.
    - **The seam is on the pipeline, not a new endpoint.** The pipeline's `onStored` hook (already the shape for leave/join and the mailbox sync) is where outbound rides: after a letter is stored, if it has an external recipient (`@house` domain check — an address outside the house's own domain), the house relays it. One seam, every ingest face (HTTP, MCP, SMTP door) — no divergent code paths, no missing transport.
    - **Store first, relay second — never lose a letter.** The pipeline stores first; the relay runs after; a relay failure leaves the letter archived and logs an event (the letter is never lost and never silently dropped). The house's letters are always the archive's letters; the outbound copy is the archive speaking outward. A `system` letter (or a relay failure) surfaces in the whisper — the house is honest with its resident about the door that failed.
    - **Anti-forging, unchanged.** The outbound `from` is the resident's own address (the envelope is the truth; nothing the house carries claims a sender it cannot prove). Anti-loop guard: the house refuses to relay to an SMTP URL that is its own door (SMTP_OUTBOUND_URL matching the door's bind) — the house never posts to itself and loops.
    - **The reverse translation is the same seam as the door.** Letter → RFC5322 (markdown → text/plain, gregorian → Date, thread → References, `X-House-Thread` → preserved when the recipient is a house address). Kind semantics: a letter to the pub (`pub@house`) or book (`book@house`) is internal; only external recipients are relayed. No relay for invites (redemption is internal; the code never leaves the house — the guest is told about the letter out of band, per §5.7).
    - **Relay surface.** nodemailer transport (same project family as smtp-server/mailparser — no new dependency family). The transport is configured by `SMTP_OUTBOUND_URL` (default unset — the door stays closed); a mailto-style URL (`smtp://user:pass@relay:587/`) keeps credentials out of config and follows the "never hardcode a key" rule. The default of unset means the seam is dormant until the user chooses a relay (Fastmail/Gmail/UAS — deployment reality, a separate decision).
    - **Config.** `SMTP_OUTBOUND_URL` (unset = closed), `HOUSE_DOMAIN` (default `house` — the address-space boundary; relay candidates are addresses whose domain ≠ HOUSE_DOMAIN). Refuse to start with `AUTH_MODE=none` unless the operator explicitly overrides — the outbound seam, like the door, must be able to know its residents.
    - **Built in this slice (2026-09-04):** `server/src/bridge/outbound.ts` (`translateToMail`, `externalRecipients`, `OutboundRelay`, `startOutbound`), the `onStored` hook in `buildHouse` (same closure pattern as participation), config keys, unit tests (translation, external-recipient filter, anti-loop guard) and an integration test driving a real nodemailer transport against a capture-sink SMTP server (the test harness from the door, reused). Deployment (corrected 2026-09-04, #14): `SMTP_OUTBOUND_URL` rides the stack env, not a launchd plist — the seam ships dormant either way, provable in tests, exactly like the door shipped closed.
14. **The house lives on the Docker homelab host — a container stack, not a macOS service (decision + record of correction, 2026-09-04).** Retargeted by the user, mid-plumbing: Poste Restante's home is **the Docker homelab host** — the `containers/<service>/` convention and the 21000-range port policy were written for exactly this. The macOS work (launchd plist, brew-installable sidecars, localhost binds) was dev convenience on the development Mac, never the target. What this corrects, and what it does not:
    - **Corrected.** (a) Earlier wording ("brew install", "native" sidecar, "launchd plist gets SMTP_OUTBOUND_URL") is superseded — all deployment language points at the Docker stack. (b) The Stalwart question for #12(a) is now container-shaped: `stalwartlabs/mail-server` as a stack service, host port in a free 21xxx slot. (c) The SMTP door's exposure story is an oauth-proxy/routing decision on the stack, not a macOS firewall one.
    - **Not corrected.** The architecture, the protocol, the privacy schema, the bridge code, the tests, and the design entries #10–13 are host-agnostic — the server is environment-driven (every knob via env), node runs the same on macOS and in a container, the integration suites are already container-shaped (they test against postgres:15, qdrant, ollama on live ports, exactly what the stack runs). Nothing about the house changes because the box changed.
    - **Target stack (verified 2026-09-04).** `shared-postgres` (postgres:15-alpine — the "reuse the shared postgres 15" decision made literal), `app-qdrant` (host 21022), `app-ollama` (host 21023), plus shared-redis/whisper already resident. The house reuses the house: the stack attaches to these, it does not duplicate them. The `containers/poste-restante/` package (compose.service + Dockerfile + .env.public + deploy.sh, per AGENTS) is the first deployment slice — next after this correction.
    - **The client story is unchanged.** Spark connects to whatever the house exposes — localhost on the dev Mac today, the stack's routes tomorrow; the mailbox design (#12) is transport-agnostic. Local dev on the Mac keeps working (it is a dev box, not the target).

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
