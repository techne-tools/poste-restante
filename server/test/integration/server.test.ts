/**
 * Letter server integration tests — the full HTTP protocol against live
 * infra (postgres 15, qdrant, ollama). Gated by POSTE_RESTANTE_INTEGRATION=1
 * so `npm test` stays hermetic in CI. Run locally with:
 *
 *   POSTE_RESTANTE_INTEGRATION=1 npm test
 *
 * Uses the dedicated test database and qdrant collection, never real data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const mkLetter = (over: Record<string, unknown> = {}) => ({
  envelope: {
    from: "hermes@house",
    to: ["you@house"],
    cc: [],
    thread: "th_9f2c1",
    kind: "letter",
    lang: "en-AU",
    subject: "re: the plural-time archive",
  },
  time: {
    gregorian: "2026-08-29T14:00:00+04:00",
    frames: [
      { frame: "islamic", value: "1448-03-15" },
      { frame: "season", value: "autumn" },
      { frame: "production", value: "tempest-tech-week" },
    ],
  },
  body: {
    format: "markdown",
    content: "## The archive, in practice\n\nWe discussed the **sound design** for the show.",
  },
  ...over,
});

describe.skipIf(!INTEGRATION)("letter server (integration)", () => {
  let house: House;
  let app: ReturnType<typeof createLetterServer>;

  beforeAll(async () => {
    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
    });
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    await house.db.pool.query(
      `TRUNCATE letters, threads, frames, addresses RESTART IDENTITY CASCADE`,
    );
    app = createLetterServer(house);
  });

  afterAll(async () => {
    await house.close();
  });

  it("delivers a letter over HTTP and it lands in all three tiers", async () => {
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(mkLetter()),
    });
    expect(res.status).toBe(201);
    const { id, created } = (await res.json()) as { id: string; created: boolean };
    expect(created).toBe(true);

    // Postgres row.
    const row = await house.repo.getLetter(id);
    expect(row).not.toBeNull();
    expect(row!.from_addr).toBe("hermes@house");

    // Qdrant vector.
    const vector = await house.embedder.embed(row!.body_text);
    const hits = await house.semantic.search(vector, 5);
    expect(hits.some((h) => h.letterId === id)).toBe(true);

    // FTS.
    const { rows: fts } = await house.db.pool.query(
      `SELECT id FROM letters WHERE to_tsvector('english', body_text) @@ plainto_tsquery('english', $1)`,
      ["sound design"],
    );
    expect(fts.some((r) => r.id === id)).toBe(true);
  });

  it("is idempotent over HTTP — the same letter returns 200 the second time", async () => {
    const letter = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_http_idem", subject: "idempotent" },
      body: { format: "markdown", content: "delivered exactly once" },
    });
    const first = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(letter),
    });
    const second = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(letter),
    });
    expect(first.status).toBe(201);
    expect(second.status).toBe(200);
    const json = (await second.json()) as { created: boolean };
    expect(json.created).toBe(false);
  });

  it("searches over HTTP — exact, full-text, and semantic paths", async () => {
    const letter = mkLetter({
      envelope: {
        from: "ben@house",
        to: ["you@house"],
        cc: [],
        thread: "th_http_search",
        kind: "letter",
        lang: "en-AU",
        subject: "the sound design discussion",
      },
      time: {
        gregorian: "2026-08-29T14:00:00+04:00",
        frames: [{ frame: "season", value: "autumn" }],
      },
      body: {
        format: "markdown",
        content: "We were worried about the show and the sound design for the tempest.",
      },
    });
    const delivered = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(letter),
    });
    const { id } = (await delivered.json()) as { id: string };

    // Exact: from ben.
    const exact = await app.request("/v1/letters?from=ben%40house", { method: "GET" });
    const exactJson = (await exact.json()) as { hits: { letterId: string }[] };
    expect(exactJson.hits.some((h) => h.letterId === id)).toBe(true);

    // Full-text: "sound design".
    const fts = await app.request("/v1/letters?text=sound%20design", { method: "GET" });
    const ftsJson = (await fts.json()) as { hits: { letterId: string }[] };
    expect(ftsJson.hits.some((h) => h.letterId === id)).toBe(true);

    // Semantic: "worried about the show".
    const sem = await app.request(
      "/v1/letters?text=worried%20about%20the%20show",
      { method: "GET" },
    );
    const semJson = (await sem.json()) as { hits: { letterId: string }[] };
    expect(semJson.hits.some((h) => h.letterId === id)).toBe(true);
  });

  it("lists the mailbox, thread, and frames over HTTP", async () => {
    const letter = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_http_mailbox", subject: "mailbox" },
      body: { format: "markdown", content: "a letter for the mailbox test" },
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(letter),
    });

    const inbox = await app.request("/v1/addresses/you@house/inbox", { method: "GET" });
    expect(inbox.status).toBe(200);
    const inboxJson = (await inbox.json()) as { letters: { envelope: { thread: string } }[] };
    expect(inboxJson.letters.some((l) => l.envelope.thread === "th_http_mailbox")).toBe(true);

    const thread = await app.request("/v1/threads/th_http_mailbox", { method: "GET" });
    expect(thread.status).toBe(200);
    const threadJson = (await thread.json()) as { letters: unknown[] };
    expect(threadJson.letters.length).toBe(1);

    const frames = await app.request("/v1/frames", { method: "GET" });
    const framesJson = (await frames.json()) as { frames: { id: string }[] };
    expect(framesJson.frames.map((f) => f.id)).toContain("season:autumn");
  });

  it("pins a letter over HTTP and it ranks above unpinned", async () => {
    const a = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_http_pin_a", subject: "pinned" },
      body: { format: "markdown", content: "a letter about the tempest and the show" },
    });
    const b = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_http_pin_b", subject: "unpinned" },
      body: { format: "markdown", content: "another letter about the tempest and the show" },
    });
    const aRes = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(a),
    });
    const bRes = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b),
    });
    const aId = ((await aRes.json()) as { id: string }).id;
    const bId = ((await bRes.json()) as { id: string }).id;

    const pin = await app.request(`/v1/letters/${aId}/pin`, { method: "POST" });
    expect(pin.status).toBe(200);

    const res = await app.request("/v1/letters?text=tempest%20show", { method: "GET" });
    const json = (await res.json()) as { hits: { letterId: string }[] };
    const rankA = json.hits.findIndex((h) => h.letterId === aId);
    const rankB = json.hits.findIndex((h) => h.letterId === bId);
    expect(rankA).toBeGreaterThanOrEqual(0);
    expect(rankB).toBeGreaterThanOrEqual(0);
    expect(rankA).toBeLessThan(rankB);
  });

  it("deletes a letter over HTTP — gone from all tiers, no soft delete", async () => {
    const letter = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_http_delete", subject: "to be deleted" },
      body: { format: "markdown", content: "this letter will be forgotten" },
    });
    const delivered = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(letter),
    });
    const { id } = (await delivered.json()) as { id: string };

    const del = await app.request(`/v1/letters/${id}`, { method: "DELETE" });
    expect(del.status).toBe(200);

    // Gone from postgres.
    expect(await house.repo.getLetter(id)).toBeNull();
    // Gone from qdrant.
    const vector = await house.embedder.embed("this letter will be forgotten");
    const after = await house.semantic.search(vector, 5);
    expect(after.some((h) => h.letterId === id)).toBe(false);
    // Gone from FTS.
    const { rows: fts } = await house.db.pool.query(
      `SELECT id FROM letters WHERE to_tsvector('english', body_text) @@ plainto_tsquery('english', $1)`,
      ["forgotten"],
    );
    expect(fts.some((r) => r.id === id)).toBe(false);
  });

  it("surfaces a house letter in the whisper and records replies", async () => {
    // A house letter (kind=system, from house@house) surfaces in the whisper.
    const houseLetter = mkLetter({
      envelope: {
        from: "house@house",
        to: ["you@house"],
        cc: [],
        thread: "th_whisper_house",
        kind: "system",
        lang: "en-AU",
        subject: "the archive, summarised",
      },
      body: {
        format: "markdown",
        content: "I summarised the tempest correspondence. Three threads, one decision.",
      },
    });
    const delivered = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(houseLetter),
    });
    expect(delivered.status).toBe(201);

    const whisper = await app.request("/v1/whisper", { method: "GET" });
    const whisperJson = (await whisper.json()) as {
      whispers: { kind: string; targetThread: string }[];
    };
    const surfaced = whisperJson.whispers.find(
      (w) => w.kind === "house-letter" && w.targetThread === "th_whisper_house",
    );
    expect(surfaced).toBeDefined();

    // Writing back marks the whisper replied.
    const reply = mkLetter({
      envelope: {
        from: "you@house",
        to: ["house@house"],
        cc: [],
        thread: "th_whisper_house",
        kind: "letter",
        lang: "en-AU",
        subject: "re: the archive, summarised",
      },
      body: { format: "markdown", content: "Good — keep the decision visible." },
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(reply),
    });

    const { rows: replied } = await house.db.pool.query(
      `SELECT replied_at FROM whispers WHERE target_thread = $1`,
      ["th_whisper_house"],
    );
    expect(replied[0]!.replied_at).not.toBeNull();
  });

  it("detects gaps — dormant threads and unanswered questions", async () => {
    // A dormant thread: two letters, last one 20 days ago.
    const old = new Date(Date.now() - 20 * 24 * 60 * 60 * 1000).toISOString();
    const a = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_gap_dormant", subject: "dormant" },
      time: { gregorian: old, frames: [] },
      body: { format: "markdown", content: "first letter of a quiet thread" },
    });
    const b = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_gap_dormant", subject: "dormant" },
      time: { gregorian: old, frames: [] },
      body: { format: "markdown", content: "second letter of a quiet thread" },
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(a),
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(b),
    });

    // An unanswered question: one letter with a question mark, 10 days old.
    const q = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_gap_question", subject: "question" },
      time: { gregorian: new Date(Date.now() - 10 * 24 * 60 * 60 * 1000).toISOString(), frames: [] },
      body: { format: "markdown", content: "Should we move the tech week to Thursday?" },
    });
    await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(q),
    });

    const gaps = await app.request("/v1/whisper/gaps", { method: "POST" });
    expect(gaps.status).toBe(200);
    const gapsJson = (await gaps.json()) as { created: string[] };
    expect(gapsJson.created.some((id) => id.includes("th_gap_dormant"))).toBe(true);
    expect(gapsJson.created.some((id) => id.includes("th_gap_question"))).toBe(true);

    // Dismissal is the strongest negative signal.
    const whisper = await app.request("/v1/whisper", { method: "GET" });
    const whisperJson = (await whisper.json()) as { whispers: { id: string }[] };
    const dormant = whisperJson.whispers.find((w) => w.id.includes("th_gap_dormant"));
    expect(dormant).toBeDefined();
    const dismiss = await app.request(`/v1/whisper/${dormant!.id}/dismiss`, { method: "POST" });
    expect(dismiss.status).toBe(200);

    const unread = await app.request("/v1/whisper?unread=1", { method: "GET" });
    const unreadJson = (await unread.json()) as { whispers: { id: string }[] };
    expect(unreadJson.whispers.some((w) => w.id === dormant!.id)).toBe(false);
  });
});
