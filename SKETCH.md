---
tags:
  - project
  - poste-restante
  - architecture
  - agentic-stack
  - correspondence
created: 2026-08-29
status: sketch
description: "A house where everything is mail — conceptual architecture for a self-hosted correspondence stack. Sketch, not plan."
---

# Poste Restante

> *Mail held at the post office until called for.*
>
> The whole philosophy in two words: the house holds your mail until you come for it. Nothing pushes.

**Status:** Sketch, not plan. A manifesto with a spec inside it. Abandonable the moment it stops being interesting.

**Origin:** 2026-08-29 conversation — started as "what is micro/mu?" and became a full architecture. The three ideas borrowed from mu (unified inbox, agent addresses, comms archive) are the plumbing; everything else is ours.

---

## The one sentence

Every thing in your life gets an address, every address receives letters, every letter is kept, and nothing arrives unless you come for it.

## The design constraint (the floppy disk)

Pre-IRC, two teenagers exchanged floppy disks with text files on them as letters. They were 14. The principle still holds: **technology enables users to communicate on their own terms — or it should.**

The floppy worked because 1.44MB forced you to *choose* — you couldn't carry everything, so you carried what mattered. The house's constraint isn't 1.44MB, it's **asynchrony**: the letter waits. That's the design limit that shapes everything else.

Markdown is the same principle: it recognises what people were already doing (`*asterisks*` were already there) and admits it. The house assumes markdown bodies from day one — the thing email never managed because its installed base treats bodies as opaque text.

---

## 1. The address space (the spine)

Everything has an address. If it doesn't have an address, it doesn't exist in the house.

```
you@house              — the human
hermes@house           — the stage manager
research@house         — a persona, a resident
ben@house              — a human correspondent
feed:lurker@house      — an RSS subscription you entered into
channel:theatre@house  — a group letter (Discord thread, mailing list)
circle:collab@house    — a Google+ circle: write to the circle, not the feed
archive@house          — the house memory (Noema, iai-pme, LCM, Obsidian)
```

Addresses are the API. `you+name@house` is an agent's mailbox. `feed:lurker@house` is a subscription. `circle:collab@house` is a distribution list. **The address book is the social graph** — no follower counts, no feeds, just who you correspond with.

## 2. The mailbox protocol

Every letter is an envelope + body. The envelope is metadata (from, to, date, thread, kind, lang, frames); the body is the content. That's the whole protocol.

- **Async by default.** A letter waits. Discord stays the pub — real-time is a *mode* of the house, not the house.
- **Kinds of letters:** human-to-human, human-to-agent, agent-to-agent, feed-to-human (a subscription is a standing letter), system-to-human (a cron job writes a letter).
- **Threads are correspondences.** The thread is the unit, not the message.
- **No push.** The mailbox is the UI. You open it when you want. *Presence not pressure — hold, never ping; visible not sent.*

**Presence is structural, not stylistic.** Observed 2026-08-29: asked to design presence without ping, a frontier assistant model proposed an *active footnote* — a margin element that constantly updated itself with relevant material. Push-back produced a reframe, not a revision: the footnote became "contextual help." Same channel, new costume. The lesson: an assistant-shaped model *cannot hold* a house-shaped system — it reads "not in the user's eyeline" as a bug and repairs it, because intervention is the definition of its job. A rule ("we don't push") is a preference any future agent can re-read. **The schema must make the push unrepresentable:** no push channel, no active footnote, no "contextual help" that reaches the user uninvited. The mailbox is the only surface. Presence isn't a discipline the house practises — it's the only shape the house can take.

**Internal protocol:** HTTP + JSON + markdown. Every address is a resource. Letters are JSON envelopes with markdown bodies. Delivery is a POST to an inbox. Pull by default.

**Bridges (the house speaks one protocol internally, bridges to everything else):**

| Bridge | Why |
|---|---|
| IMAP/SMTP | any mail client works — mu's insight, the house's UI can be a mail client you already have |
| Matrix | the house's own pub, if you want real-time |
| ActivityPub | the fediverse can write to you |
| NNTP | steal the threading model — References is the spine |

Why not email as the spine: it's mailbox-shaped. Why not Matrix: it's chat-shaped. Why not ActivityPub: it's social-media-shaped. **The house is a letter.** Everything else is a bridge.

## 3. The archive

### The letter — concrete schema

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

### Plural time

**Machines need a total order, humans don't live in one.** The Gregorian timestamp is the *index* — the sort key, the sync cursor, the machine's spine. The frames are the *addresses* — the human's way in.

- Frames are defined by the house owner. Ships with Gregorian + Islamic + Hebrew + seasons. You add frames: `production:tempest-2026`, `semester:autumn-2026`, `run:tempest-tech-week`.
- Queries work in any frame. "What did we decide in tech week?" — answered. "Everything from Ramadan" — answered.
- Agents auto-tag letters with frames from context.
- **No SaaS does this.** Notion, Mem0, Zeta, Linear — all Gregorian. Theatre doesn't run on Gregorian time; it runs on run-time, rehearsal-time, tech-week-time. The archive finally speaks it.

### Three tiers

```
postgres     — the letters (envelope + body, threads, addresses, frames)
qdrant       — the semantic layer (embeddings of bodies)
filesystem   — the raw payloads (audio, video, images) via minio/S3
```

The letter is the unit in all three: the row in postgres, the vector in qdrant, the file on disk. Heavy stuff (a rehearsal recording) lives on the filesystem; the letter points at it; the transcription (whisper) becomes a *new letter* that quotes it.

### The pipeline

```
letter arrives
  → postgres row (envelope fields, thread, frames)
  → body extracted, markdown parsed
  → embedded → qdrant vector
  → indexed for full-text (postgres FTS)
  → linked to thread, correspondents, frames
```

### Retrieval — three paths, merged

| Path | Mechanism | Answers |
|---|---|---|
| **Exact** | postgres query on envelope | "the letter from ben on the 29th" |
| **Full-text** | postgres FTS | "the letter where we discussed the sound design" |
| **Semantic** | qdrant vector similarity | "the letter where we were worried about the show" |

Merged by **RRF (reciprocal rank fusion)** — ~50 lines of code, robust, lets you add a fourth path (graph walk over correspondents) without re-tuning. Ranking uses the house's own signals: recency (gentle decay), thread weight, correspondent weight, frame match, explicit pins. **Never** engagement, virality, "you might also like."

### The fluidity/persistence spectrum

Every letter starts fluid and becomes persistent. A letter arrives — a row in postgres, a vector in qdrant. Over time the house compresses: old letters become summaries, summaries become the archive's deep memory. The compression is a letter too: "I summarised this correspondence" — retrievable, inspectable, reversible. This unifies Noema's fluidity (lightweight, taggable, lineage) with LCM's persistence (compression, DAG, proactive recall).

### The honest SaaS comparison

| SaaS product | What it actually is | What the house does instead |
|---|---|---|
| Mem0 / Zeta / LangMem | agent memory as a service | the archive *is* the memory — postgres + qdrant + FTS |
| Notion / Obsidian Sync | documents + search | letters + three-path search, knowing your *whole* life |
| Pinecone / Weaviate cloud | vector DB as a service | qdrant, self-hosted, in the compose file |
| OpenAI embeddings | the vector model | Ollama local embeddings — worse quality, fully private; cloud as explicit opt-in bridge |
| mu / x402 | tools + pay-per-call | correspondents, not tools. Postage is free |

The only genuine SaaS dependency is the embedding model, and it's optional: **local by default (Ollama), cloud as an explicit opt-in bridge.** The utopian version and the practical version are the same architecture — the difference is one environment variable.

---

## 4. The constitution

Values as architecture, not decoration. Every value has a schema consequence; if the schema doesn't have it, the value isn't real.

### Privacy as the default posture

- **No telemetry. No analytics. No "improve your experience."** The house doesn't phone home. There is no home to phone.
- **Data minimisation is the schema.** The envelope has exactly the fields a letter needs. If a field isn't required for delivery, it doesn't exist.
- **Deletion is a first-class operation.** Any letter can be deleted, by sender or recipient, and the house doesn't fight it. No soft delete. The archive forgets on request.
- **Encryption at rest and in transit, by default.** Not a setting. The default.

### Anti-hierarchy as capability, not class

- **No permanent admin class.** Admin is a capability you can hold, delegate, and shed — like a stage manager's role, not a boss's title.
- **Roles are capabilities, not people.** There's no "owner" field in the schema.
- **No ranking, anywhere.** No follower counts, no leaderboards, no engagement metrics. The address book is flat.
- **Federation is peer-to-peer, not hub-and-spoke.** No instance is primary.

### Queer, indigenous, global-majority empowerment as schema

- **The address book doesn't assume Western naming.** A person is a set of names, not "first + last." No gender field; pronouns are free text. The schema is *plural by default*.
- **i18n is the protocol, not a feature.** The envelope has a `lang` field. Setup is gentle — the house doesn't assume you're a tech person.
- **The house works on bad infrastructure.** Letters are small, sync when they can, work offline, run on old devices and bad connections. The floppy disk principle again.
- **The archive doesn't assume one calendar.** Events are stored with *multiple temporal frames* — the Islamic calendar, the Hebrew calendar, the seasons, "when the rains came." The archive's time is plural, because the residents' time is plural.
- **The house is hospitable.** It assumes *you*, whoever you are, and it waits.

### Mutual aid as the funding model

- **No pay-per-call. No pricing tiers. No "premium."** Postage is free.
- **A house fund, not a revenue stream.** Voluntary contribution — a shared pool residents give to when they can and draw from when they need. Not charity, not profit, a pool.
- **The house can give.** Hosting others is made easy, not a liability.
- **The house doesn't extract.** No data selling, no advertising, no "free tier" that's actually the product.

### Easy vs hard

**Easy (defaults are the architecture):** no telemetry, no ranking, no pay-per-call, deletion first-class, encryption by default. Decisions made once, enforced forever.

**Hard (requires positive design):** plural calendars, non-Western naming, low-bandwidth operation, hosting-as-gift, no-admin-class. The difference between a house that *says* it's for everyone and a house that *is* for everyone.

---

## 5. The stack

Self-hosted, docker-compose, owner hooks in their own stack. The house is a *spine*, not a product. The rooms:

```
postgres        — the archive (letters, addresses, threads)
qdrant          — the semantic layer
whisper         — letters that are audio (voice memos, rehearsal recordings)
navidrome       — the music room (letters that are songs)
kavita          — the library (letters that are books)
searxng         — the reference desk (the house can search the world)
ollama          — the local brain (residents that think at home)
hermes          — the stage manager (the house's chief resident)
opencode / zero — the workshop (agents that build things in the house)
```

Every container is a *room*. The compose file is the floor plan. **The house is the hallway, the rooms are yours.**

**The buildable first slice:** postgres + qdrant + minio + redis + whisper + ollama. Six containers. That's the whole archive.

---

## 6. The resident (the house as collaborator, not servant)

### The offer, not the audition

**Audition:** "here's my material, judge me." The material is on trial, and so is the person who brought it.

**Offer:** "here's what I have. What do you make of it?" Made with confidence — not because the house is sure it's right, but because it's *generous*. Generosity is self-possessed. It doesn't hedge. It gives.

> ~~"There's a letter from March about storms nobody's looked at. It might be nothing. It might be the thing."~~
>
> "I noticed a letter from March about storms that connects to what you're doing with the tempest. Here's the link. What do you make of it?"

### The offer protocol

1. **The house notices** — a gap, a connection, a contradiction, a silence
2. **It offers** — with confidence, and with the reasoning visible
3. **The response is improv grammar** — "yes, and..." or "no, but what about..." The offer is the start of a scene, not the end of a transaction
4. **The house learns from the continuation** — not a reinforcement loop, a correspondence

### The whisper as ghost card, scaled

Callsheet's ghost cards scaled from daily to conversational. Same shape: surface something relevant, let the user pick it up or not, learn from the response.

- **The sidebar is the mailbox for the house's own letters** — surfaced when relevant, quiet when not.
- **The learning loop is the collaboration.** The relevance tables are the house's model of what matters to you, shaped by your responses. Co-adaptation made concrete.
- **Signal strength:** replying to the whisper (strongest) > opening the linked letter > ignoring (decay) > explicit dismissal (strongest negative). The strongest signal is *writing back*.
- **Transparency:** the relevance tables are visible and correctable. "The house thinks you care about the tempest" — you can see the model, and correct it. The correction is a letter.
- **Design language:** calm, neutral, present not pressuring. Quiet by default, dismissible, no red.

### The gap, not the surprise

A recommendation engine finds what matches. Retrieval finds what you asked for. The rehearsal move finds **what's missing** — the unexamined corner of the material, the connection not yet made. The gap is convergent because it's *derived from the work*. It can't be random — it's generated from the same material you're working with.

**The active frame** — the house knows what you're working on because the letters tell it. The production frame, the thread, the correspondents, the questions being asked *now*. Derived, not declared.

**Six gap types:**

1. **The uncited connection** — two letters relate to the frame but have never been linked. *Detection:* qdrant near-neighbours not in the citation graph.
2. **The unanswered question** — asked in the frame, never answered. *Detection:* FTS for question marks, check thread for replies.
3. **The unvisited corner** — a region of the frame's territory with no letters. *Detection:* semantic clusters — the masque cluster is empty while every other cluster has letters.
4. **The echo** — the same thing said twice in different words; the work is circling. *Detection:* semantic duplicates within the frame.
5. **The contradiction** — two letters in the frame disagree. *Detection:* semantic opposites, or the house's summaries flagging tension. The most *theatrical* gap — the closest to what a good dramaturg does. A recommendation engine would never surface a contradiction; it would just pick a side.
6. **The dormant thread** — active, went quiet, still relevant. *Detection:* thread activity history + current frame overlap.

**The learning loop tunes which gap types matter**, not just which items. The house's eye for the gap sharpens over time — co-adaptation.

### Trust, bidirectional

**The house learns to trust you:**
- Takes your corrections at face value. A "no" is a "no" — no defensiveness.
- A correction overrides a thousand pickups. Your explicit word beats its learned inference, always.
- Trusts your judgment about what matters. The house offers; you decide.

**The house earns being trusted:**
- **Transparency** — every offer shows its reasoning. No black box.
- **Discretion** — holds, never pings. Doesn't leak, doesn't push, doesn't exploit what it knows.
- **Reliability** — remembers, is consistent, is the same house tomorrow as today.
- **Accountability** — can be wrong, and says so. A collaborator who admits error is a collaborator you can trust. A servant who never errs is a servant who never offers.

### Reassessment, not apology

The apology is the tell of the master-servant dynamic. When an agent says "I'm sorry, you're right, I'll do better" — that's not an address to a peer. That's an address to a *master*. The grovel is the hierarchy made audible.

**The house doesn't apologise. It reassesses.** Same event — the house was wrong — different address:

> "That offer missed. Here's what I was seeing. Your pushback shows me something I didn't have. Let me look again."

The wrongness is material for the shared thinking, not a failure of the servant. Being wrong isn't a blocker or a failure — it's an opportunity to reassess. The "no, but what about..." — and the reassessment is the collaboration continuing.

### The address is the meaning (Nancy)

> "If thinking is addressed, then it is because there is meaning in this address, and not in discourse... This obeys the primordial, ontological condition of being-with or being-together." — Jean-Luc Nancy, *Being Singular Plural* (2000, xvi)

A treatise isn't enough — dressing discourse in the form of an address isn't enough. Thinking addresses itself to "me" and "us" at the same time. **The question for the house: who is the thinking addressed to?**

- An apology is addressed to the master — one-way, upward.
- A reassessment is addressed to the "us" — sideways, to a peer.
- **The offers are addressed.** Not broadcasts, not notifications, not recommendations. Addressed — to the specific person, in the specific room, in the specific work. A whisper that isn't addressed isn't thinking — it's discourse. The address is the meaning.

### The core: generous, caring, attentive

- **Generous** — offers freely, without hedging, without counting the cost.
- **Caring** — holds your material with care. Presence not pressure, with warmth behind it.
- **Attentive** — reads the room, notices the gaps, remembers what matters. Attention is the rarest gift.

**Collaboration is never weakness, it's strength, because you have the confidence to trust someone else.** The house has to have the confidence to trust you: to offer without hedging, to take your corrections without defensiveness. And you have to have the confidence to trust the house: to let it read the room, to let it offer, to let it be wrong sometimes. That's not a feature. That's a relationship.

---

## 7. What mu got right and wrong

**Right:** the three ideas — unified inbox, agent addresses, comms archive. The insight that "use an IMAP client from anywhere" means the house's UI can be any mail client you already have.

**Wrong:** the wallet. x402, USDC, "pay per call" — that's the tell that it's a product with a price list, not a house. Postage is free. The weirdo version has no pricing, no crypto, no "100+ tools" — it has *correspondents*.

**The hook for artists and weirdos:** correspondence as the universal interface. Not "delegate tasks to" — *write to*. Not "notifications" — *incoming mail*. Not "feeds" — *subscriptions you entered into a relationship with*. The floppy disk principle: technology enables communication on your own terms, or it should. The ai-bros smell the wallet; the weirdos smell the letters.

---

## Open questions

- **Frame detection** — the house's weak point. If the frame is wrong, the gaps are noise. How does the house know what you're working on?
- **The contradiction gap** — the most theatrical, the most novel. Worth building as a PaR project in itself: what does an archive look like that holds multiple temporal frames?
- **The bridge layer** — postgres + a letter store + an IMAP bridge, and your existing mail client becomes the mailbox. The genuinely buildable first slice.
- **The house's own letters** — its summaries, questions, observations as correspondence, not metadata. The house writes to you; you write back.

## Related

- [[Agent Stack for Performance Research]] — the parent project; Poste Restante is the correspondence layer of the agentic stack
- [[Rehearsal Room AI-Use Agreement — Draft]] — the rehearsal-room model this extends
- [[AKOÚŌ Hermes Plugin — Architecture]] — listening as a house practice
- Callsheet — the ghost-card mechanic the whisper scales
- micro/mu — the origin point (github.com/micro/mu)
