/**
 * Integration tests — the full archive spine against live infra.
 *
 * These require postgres 15, qdrant, and ollama (with an embedding model).
 * They are gated by POSTE_RESTANTE_INTEGRATION=1 so `npm test` stays hermetic
 * in CI (which has none of these). Run locally with:
 *
 *   POSTE_RESTANTE_INTEGRATION=1 npm test
 *
 * The test uses a dedicated database (poste_restante_test) and a dedicated
 * qdrant collection (letters_test) so it never touches real data.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import type { Letter } from "../../src/types.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const mkLetter = (over: Partial<Letter> = {}): Letter => ({
  id: "",
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

describe.skipIf(!INTEGRATION)("archive spine (integration)", () => {
  let house: Awaited<ReturnType<typeof buildHouse>>;

  beforeAll(async () => {
    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
    });
    // Fresh semantic collection for the test.
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    // Fresh postgres state for the test (cascade clears links).
    await house.db.pool.query(
      `TRUNCATE letters, threads, frames, addresses RESTART IDENTITY CASCADE`,
    );
  });

  afterAll(async () => {
    await house.close();
  });

  it("ingests a letter into postgres, qdrant, and FTS, with correct links", async () => {
    const letter = mkLetter();
    const res = await house.pipeline.ingest(letter);
    expect(res.created).toBe(true);

    // Postgres row.
    const row = await house.repo.getLetter(res.letterId);
    expect(row).not.toBeNull();
    expect(row!.from_addr).toBe("hermes@house");
    expect(row!.to_addrs).toEqual(["you@house"]);
    expect(row!.thread_id).toBe("th_9f2c1");
    expect(row!.kind).toBe("letter");
    expect(row!.body).toContain("sound design");
    expect(row!.body_text).toContain("sound design");
    expect(row!.body_text).not.toContain("**");

    // Frames linked.
    const frameNames = row!.frames.map((f) => `${f.frame}:${f.value}`).sort();
    expect(frameNames).toEqual([
      "islamic:1448-03-15",
      "production:tempest-tech-week",
      "season:autumn",
    ]);

    // Correspondents linked.
    const { rows: corr } = await house.db.pool.query(
      `SELECT address_id, role FROM letter_addresses WHERE letter_id = $1 ORDER BY role`,
      [res.letterId],
    );
    expect(corr).toHaveLength(2);
    expect(corr).toContainEqual({ address_id: "hermes@house", role: "from" });
    expect(corr).toContainEqual({ address_id: "you@house", role: "to" });

    // Qdrant vector present.
    const vector = await house.embedder.embed(row!.body_text);
    const hits = await house.semantic.search(vector, 5);
    expect(hits.some((h) => h.letterId === res.letterId)).toBe(true);

    // FTS hit.
    const { rows: fts } = await house.db.pool.query(
      `SELECT id FROM letters WHERE to_tsvector('english', body_text) @@ plainto_tsquery('english', $1)`,
      ["sound design"],
    );
    expect(fts.some((r) => r.id === res.letterId)).toBe(true);
  });

  it("is idempotent — the same letter is not stored twice", async () => {
    const letter = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_idem", subject: "idempotency" },
      body: { format: "markdown", content: "a letter that must be stored exactly once" },
    });
    const first = await house.pipeline.ingest(letter);
    const second = await house.pipeline.ingest(letter);
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.letterId).toBe(first.letterId);

    const { rows } = await house.db.pool.query(
      `SELECT count(*)::int AS n FROM letters WHERE id = $1`,
      [first.letterId],
    );
    expect(rows[0]!.n).toBe(1);
  });

  it("retrieves the letter via all three paths and merges by RRF", async () => {
    // Ensure a distinct letter for retrieval.
    const letter = mkLetter({
      envelope: {
        from: "ben@house",
        to: ["you@house"],
        cc: [],
        thread: "th_retrieval",
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
    const ingestRes = await house.pipeline.ingest(letter);
    const id = ingestRes.letterId;

    // Exact: from ben.
    const exact = await house.retrieval.search({ from: "ben@house" });
    expect(exact.some((h) => h.letterId === id)).toBe(true);

    // Full-text: "sound design".
    const fts = await house.retrieval.search({ text: "sound design" });
    expect(fts.some((h) => h.letterId === id)).toBe(true);

    // Semantic: "worried about the show".
    const sem = await house.retrieval.search({ text: "worried about the show" });
    expect(sem.some((h) => h.letterId === id)).toBe(true);

    // RRF merge: a query that hits multiple paths returns the letter with
    // multiple contributing paths.
    const merged = await house.retrieval.search({ text: "sound design", from: "ben@house" });
    const hit = merged.find((h) => h.letterId === id);
    expect(hit).toBeDefined();
    expect(hit!.paths.length).toBeGreaterThanOrEqual(2);
  });

  it("does not merge the whole archive into a free-text search", async () => {
    // Regression: with a text query and no envelope filters, the exact path
    // used to fall back to browse mode and return every letter, drowning the
    // RRF merge. A text-only search must not return letters that match
    // neither FTS nor semantic.
    const a = await house.pipeline.ingest(
      mkLetter({
        envelope: { ...mkLetter().envelope, thread: "th_text_only_a", subject: "the tempest" },
        body: { format: "markdown", content: "the tempest and the sound design" },
      }),
    );
    const b = await house.pipeline.ingest(
      mkLetter({
        envelope: { ...mkLetter().envelope, thread: "th_text_only_b", subject: "unrelated" },
        body: { format: "markdown", content: "completely unrelated grocery list" },
      }),
    );

    const res = await house.retrieval.search({ text: "tempest sound" });
    const ids = res.map((h) => h.letterId);
    expect(ids).toContain(a.letterId);
    // The unrelated letter must not come back via the exact path — that is
    // the regression: the exact path used to browse the whole archive and
    // merge every letter into the RRF. (It may still appear via semantic on
    // a tiny corpus — qdrant returns nearest neighbours even when nothing
    // is genuinely similar — but never as an exact-path hit.)
    const bHit = res.find((h) => h.letterId === b.letterId);
    if (bHit) {
      expect(bHit.paths).not.toContain("exact");
    }
  });

  it("ranks a pinned letter above an unpinned one", async () => {
    const a = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_pin_a", subject: "pinned letter" },
      body: { format: "markdown", content: "a letter about the tempest and the show" },
    });
    const b = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_pin_b", subject: "unpinned letter" },
      body: { format: "markdown", content: "another letter about the tempest and the show" },
    });
    const aRes = await house.pipeline.ingest(a);
    const bRes = await house.pipeline.ingest(b);
    await house.repo.pinLetter(aRes.letterId, "you@house");

    const res = await house.retrieval.search({ text: "tempest show" });
    const rankA = res.findIndex((h) => h.letterId === aRes.letterId);
    const rankB = res.findIndex((h) => h.letterId === bRes.letterId);
    expect(rankA).toBeGreaterThanOrEqual(0);
    expect(rankB).toBeGreaterThanOrEqual(0);
    expect(rankA).toBeLessThan(rankB);
  });

  it("deletes a letter from postgres, qdrant, and FTS — no soft delete", async () => {
    const letter = mkLetter({
      envelope: { ...mkLetter().envelope, thread: "th_delete", subject: "to be deleted" },
      body: { format: "markdown", content: "this letter will be forgotten" },
    });
    const res = await house.pipeline.ingest(letter);
    expect(res.created).toBe(true);

    // Confirm it's present in all tiers.
    expect(await house.repo.getLetter(res.letterId)).not.toBeNull();
    const vector = await house.embedder.embed("this letter will be forgotten");
    const before = await house.semantic.search(vector, 5);
    expect(before.some((h) => h.letterId === res.letterId)).toBe(true);

    // Delete.
    const removed = await house.pipeline.delete(res.letterId);
    expect(removed).toBe(true);

    // Gone from postgres.
    expect(await house.repo.getLetter(res.letterId)).toBeNull();
    // Gone from qdrant.
    const after = await house.semantic.search(vector, 5);
    expect(after.some((h) => h.letterId === res.letterId)).toBe(false);
    // Gone from FTS.
    const { rows: fts } = await house.db.pool.query(
      `SELECT id FROM letters WHERE to_tsvector('english', body_text) @@ plainto_tsquery('english', $1)`,
      ["forgotten"],
    );
    expect(fts.some((r) => r.id === res.letterId)).toBe(false);
    // Links gone too (cascade).
    const { rows: links } = await house.db.pool.query(
      `SELECT count(*)::int AS n FROM letter_addresses WHERE letter_id = $1`,
      [res.letterId],
    );
    expect(links[0]!.n).toBe(0);
  });
});
