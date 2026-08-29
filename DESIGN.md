# Design

<!-- impeccable:design-schema 1 -->

## North Star

The house is calm. It holds, it never pings. *Presence not pressure — hold, never ping; visible not sent.* This is the callsheet lineage extended from a day-board to a whole house: the same quiet, the same restraint, the same trust in the user to come when they're ready.

## Design Principles

1. **The house is headless; the UI is composed.** The house has no UI of its own — it exposes primitives (letters, threads, addresses, frames, whispers) as a protocol. The Tauri app is the *reference client* (where the whisper lives by default), not THE UI. The user composes their own space from clients: cmux, shell, obsidian, neomutt, a web client. Google+ was overwhelm because the platform composed the space; a cmux setup is freedom because the user composes the space. Same threads, same columns — different composer.

2. **Composable, not generative.** The user composes the space (composable UI); the house generates the *letters* (generative content — the whisper, the gap offers, the frame navigation). Generation is for what's said; composition is for where it's seen. The house must never compose the space — not with a product team, and not with a model. Generative *layout* is the platform composing for you again, with extra latency.

3. **The letter is the unit.** Envelope + markdown body. Everything is a letter: human-to-human, human-to-agent, agent-to-agent, feed-to-human, system-to-human. Threads are correspondences. The letter is the unit in all three archive tiers (postgres row, qdrant vector, minio file).

4. **Plural time.** Gregorian is the index (the machine's spine); frames are the addresses (the human's way in). `production:tempest-2026`, `semester:autumn-2026`, `run:tech-week`, islamic, seasons. Queries work in any frame. The archive's time is plural because the residents' time is plural.

5. **The offer, not the audition.** The house offers with confidence and visible reasoning — "here's what I have, what do you make of it?" — never hedges, never grovels. The response grammar is improv: "yes, and..." / "no, but what about...". Wrongness is reassessment, not apology: "That offer missed. Here's what I was seeing. Let me look again."

6. **The gap, not the surprise.** The house finds what's *missing* from the current work — convergent by construction, derived from the active frame. Six gap types: uncited connection, unanswered question, unvisited corner, echo, contradiction, dormant thread. A recommendation engine would never surface a contradiction; the house does — that's the dramaturg's move.

7. **The address is the meaning (Nancy).** Thinking addresses itself to "me" and "us" at the same time. Offers are addressed — to the specific person, in the specific room, in the specific work. An unaddressed whisper isn't thinking, it's discourse.

## Design Language

Callsheet's lineage, extended to the house:

- **Calm, neutral, present not pressuring.** Quiet by default. Dismissible. No red for errors (ink-secondary grey).
- **The whisper sidebar** is the mailbox for the house's own letters — surfaced when relevant, quiet when not. Ghost-card lineage: surface, pick up or ignore, learn.
- **The reference client** (Tauri v2 + React): mailbox, whisper sidebar, address book, archive browser. Built as *a* client, not *the* client — the protocol is the product, the app is the proof.
- **The pub** is first-class content: instance-native slow-social, thread-based conversation. The pub is the *content*; the client is the *space*.

## Design System

**Bound (2026-08-29).** The design language is locked and captured in `.impeccable/design.json` — the machine-readable token spec the reference client consumes. The specimen that proves it is `design-language-specimen.html` (Open Design workspace). The design truth lives in the spec; this file and SPEC.md §2.5 are the north star.

**The material — warm paper, warm ink, one seal.** The house is warm, not cool. A letter on warm paper, written in warm ink, sealed with a single wax mark. One accent (seal-wax terracotta), used at most twice on any surface — the seal, never the page.

**The three voices.** Serif is the letter (the writer's voice — headings, ledes, signoffs). Sans is the reading (the reader's voice — body, UI). Mono is the machine (addresses, frames, kickers, kind labels, metadata — never body prose).

**The unit and the frame.** The envelope / the letter is the unit — the object every surface is made of. Plural time is the framework — the navigation. This is realised through the **Horizon View**: a single vertical flow of letters, flanked by parallel lines representing overlapping active frame spans (like a transit diagram). Selecting a frame line brings its associated letters to the foreground and dims the rest, showing exactly where contexts intersect.

**The governing inversion.** Familiar shape, opposite operation. The pub reads as a channel, the letter as a DM — so the house is legible at a glance — but the operation inverts the platform: slow, careful, generous, considerate. The design borrows the *shape* of the familiar and refuses its *behaviour*.

**Interaction contract.** Presence not pressure — hold, never ping; visible not sent. No pings, no badges, no counts, no alert tones. No red for errors (ink-secondary grey). Hover/focus never lowers contrast; every focusable element has an accent `:focus-visible` ring.

## What this is not

- Not a feed. No infinite scroll, no engagement, no "you might also like."
- Not a dashboard. No metrics, no leaderboards, no ranking.
- Not a chat app. Real-time is a *mode* of the house, not the house.
- Not a platform's UI. The house never composes the space.
