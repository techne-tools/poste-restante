/**
 * Scrub — the safety move (SPEC §19) — integration tests.
 *
 * These prove the whole arc against live infra (postgres 15, qdrant,
 * ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   scrub → the resident's letters are deleted from all three tiers
 *         → the other party's letters stay (the house cannot delete
 *           what the resident does not own)
 *         → the resident's view of the thread is gone (404, never 403)
 *         → whispers pointing at the thread die with it
 *
 * And the privacy rules: absence is silence; the book is exempt (clause
 * threads are commons by right); the move is unilateral and immediate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import { BookService } from "../../src/book/service.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("scrub (integration)", () => {
  let house: House;
  let auth: AuthService;
  let app: ReturnType<typeof createLetterServer>;

  beforeAll(async () => {
    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
      AUTH_MODE: "basic",
    });
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    await house.db.pool.query(
      `TRUNCATE invites, whispers, clauses, clause_objectors, clause_vouchers,
              thread_participation, letters, threads, frames, addresses, credentials
       RESTART IDENTITY CASCADE`,
    );
    await house.db.pool.query(
      `INSERT INTO addresses (id, is_public) VALUES ('book@house', false), ('pub@house', true)`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth, house.whisper);
    await auth.setPassword("you@house", "youyouyou");
    await auth.setPassword("ben@house", "benbenben");
    const book = new BookService(house.db.pool, house.pipeline, house.repo, house.log, 7);
    app = createLetterServer(house, { auth, book });
  });

  afterAll(async () => {
    await house.close();
  });

  /** Deliver a letter from `from` to `to` in a fresh thread (or the given one). */
  async function deliver(
    from: string,
    to: string[],
    subject: string,
    body: string,
    threadOverride?: string,
  ): Promise<{ id: string; thread: string }> {
    const password = from === "you@house" ? "youyouyou" : "benbenben";
    const thread = threadOverride ?? `th_scrub_${Math.random().toString(36).slice(2, 10)}`;
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { Authorization: basic(from, password) },
      body: JSON.stringify({
        envelope: {
          from,
          to,
          cc: [],
          thread,
          kind: "letter",
          lang: "en-AU",
          subject,
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: body },
      }),
    });
    expect(res.status).toBe(201);
    const body2 = (await res.json()) as { id: string };
    return { id: body2.id, thread };
  }

  it("scrubs the resident's letters — the other party's stay, the view is gone", async () => {
    const { id: mine, thread } = await deliver("you@house", ["ben@house"], "the tempest", "the storm is coming");
    const { id: theirs } = await deliver("ben@house", ["you@house"], "re: the tempest", "the storm will pass", thread);

    // you scrubs the thread.
    const res = await app.request(`/v1/threads/${thread}/scrub`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { scrubbed: boolean; deleted: number };
    expect(body.scrubbed).toBe(true);
    expect(body.deleted).toBe(1); // only you's letter

    // you's letter is gone from the archive.
    const mineGone = await house.repo.getLetter(mine);
    expect(mineGone).toBeNull();

    // ben's letter stays — the house cannot delete what you do not own.
    const theirsStays = await house.repo.getLetter(theirs);
    expect(theirsStays).not.toBeNull();

    // you's view of the thread is gone — 404, never 403.
    const youView = await app.request(`/v1/threads/${thread}`, {
      method: "GET",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(youView.status).toBe(404);

    // ben still reads the thread — their correspondence is intact.
    const benView = await app.request(`/v1/threads/${thread}`, {
      method: "GET",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(benView.status).toBe(200);
  });

  it("scrub is unilateral — a non-participant cannot scrub a thread they cannot see", async () => {
    const { thread } = await deliver("you@house", ["ben@house"], "private", "just us");

    // ben is a participant — fine. A stranger (no credential) gets 401.
    const anon = await app.request(`/v1/threads/${thread}/scrub`, {
      method: "POST",
    });
    expect(anon.status).toBe(401);
  });

  it("the book is exempt — clause threads cannot be scrubbed", async () => {
    // Offer a clause to the book.
    const offer = await app.request("/v1/book", {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({ role: "offer", text: "the house holds the boundary" }),
    });
    expect(offer.status).toBe(201);
    const { clause } = (await offer.json()) as { clause: { thread: string } };

    const scrub = await app.request(`/v1/threads/${clause.thread}/scrub`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(scrub.status).toBe(400);
  });

  it("whispers pointing at a scrubbed thread die with it", async () => {
    const { thread } = await deliver("you@house", ["ben@house"], "the quiet thread", "going quiet");

    // Detect gaps — a dormant-thread whisper may be created for this thread.
    await app.request("/v1/whisper/gaps", {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });

    // Scrub.
    await app.request(`/v1/threads/${thread}/scrub`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });

    // No whisper points at the thread any more.
    const { rows } = await house.db.pool.query<{ id: string }>(
      `SELECT id FROM whispers WHERE target_thread = $1`,
      [thread],
    );
    expect(rows).toHaveLength(0);
  });
});
