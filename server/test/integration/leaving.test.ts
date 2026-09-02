/**
 * Leaving as first-class — integration tests (SPEC §5.8 related).
 *
 * These prove the whole arc against live infra (postgres 15, qdrant,
 * ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   leave → the leaver's edges dissolve (404, never 403)
 *        → the whisper stops offering the thread
 *        → gaps are not even created for it
 *   rejoin → the historical edges stand again
 *
 * And the privacy rules: absence is silence; the book is exempt (clause
 * threads are commons by right); the move is symmetric by construction.
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

describe.skipIf(!INTEGRATION)("leaving as first-class (integration)", () => {
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
    auth = new AuthService(house.db.pool, house.log, house.config.auth);
    await auth.setPassword("you@house", "youyouyou");
    await auth.setPassword("ben@house", "benbenben");
    await auth.setPassword("sam@house", "samsamsam");
    const book = new BookService(house.db.pool, house.pipeline, house.repo, house.log, 7);
    app = createLetterServer(house, { auth, book });
  });

  afterAll(async () => {
    await house.close();
  });

  /** Deliver a letter from `from` to `to` in a fresh thread. */
  async function deliver(
    from: string,
    to: string[],
    subject: string,
    body: string,
  ): Promise<{ id: string; thread: string }> {
    const password = from === "you@house" ? "youyouyou" : from === "ben@house" ? "benbenben" : "samsamsam";
    const thread = `th_leave_${Math.random().toString(36).slice(2, 10)}`;
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

  it("a resident can leave a thread — the act IS a letter, participation flips to out", async () => {
    const { thread } = await deliver("you@house", ["ben@house"], "the tempest", "the storm is coming");

    const res = await app.request(`/v1/threads/${thread}/leave`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { participation: string };
    expect(body.participation).toBe("out");

    // The act IS a letter — kind leave, in the thread.
    const { rows } = await house.db.pool.query<{ kind: string }>(
      `SELECT kind FROM letters WHERE thread_id = $1 AND kind = 'leave'`,
      [thread],
    );
    expect(rows).toHaveLength(1);
  });

  it("a leaver gets 404 on the thread — absence is silence, never 403", async () => {
    const { thread } = await deliver("you@house", ["ben@house"], "the tempest", "the storm is coming");
    await app.request(`/v1/threads/${thread}/leave`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });

    const res = await app.request(`/v1/threads/${thread}`, {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(res.status).toBe(404);
  });

  it("other participants are unaffected — the leaver's edges dissolve, theirs stand", async () => {
    const { thread } = await deliver("you@house", ["ben@house"], "the tempest", "the storm is coming");
    await app.request(`/v1/threads/${thread}/leave`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });

    const res = await app.request(`/v1/threads/${thread}`, {
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { participation: string; letters: unknown[] };
    expect(body.participation).toBe("in");
    expect(body.letters.length).toBeGreaterThan(0);
  });

  it("the whisper stops offering a thread the resident has left", async () => {
    const { id, thread } = await deliver("you@house", ["ben@house"], "the tempest", "the storm is coming");
    // A whisper exists for the thread (the house's own letter).
    await house.whisper.surfaceHouseLetter(id, thread, "the storm is coming");
    // The resident can see it while 'in'.
    const before = await house.whisper.list("you@house");
    expect(before.some((w) => w.targetThread === thread)).toBe(true);

    await app.request(`/v1/threads/${thread}/leave`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });

    const after = await house.whisper.list("you@house");
    expect(after.some((w) => w.targetThread === thread)).toBe(false);
  });

  it("gaps are not even created for a thread the resident has left", async () => {
    const { thread } = await deliver("you@house", ["ben@house"], "the tempest", "the storm is coming");
    await app.request(`/v1/threads/${thread}/leave`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });

    // Fast-forward the thread's last letter so it would be dormant.
    await house.db.pool.query(
      `UPDATE letters SET received_at = received_at - interval '20 days'
       WHERE thread_id = $1`,
      [thread],
    );

    const gaps = await house.whisper.detectGaps("you@house");
    expect(gaps.some((g) => g.targetThread === thread)).toBe(false);
  });

  it("rejoining restores the historical edges — the thread is visible again", async () => {
    const { thread } = await deliver("you@house", ["ben@house"], "the tempest", "the storm is coming");
    await app.request(`/v1/threads/${thread}/leave`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const gone = await app.request(`/v1/threads/${thread}`, {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(gone.status).toBe(404);

    const join = await app.request(`/v1/threads/${thread}/join`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(join.status).toBe(201);
    const joinBody = (await join.json()) as { participation: string };
    expect(joinBody.participation).toBe("in");

    const back = await app.request(`/v1/threads/${thread}`, {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(back.status).toBe(200);
    const body = (await back.json()) as { participation: string; letters: unknown[] };
    expect(body.participation).toBe("in");
    expect(body.letters.length).toBeGreaterThan(0);
  });

  it("the book is exempt — you cannot leave the household's knowing of itself", async () => {
    // Offer a clause (the book's thread).
    const offer = await app.request("/v1/book", {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({ role: "offer", text: "the pub closes at dusk" }),
    });
    expect(offer.status).toBe(201);
    const offerBody = (await offer.json()) as { clause: { thread: string } };

    const leave = await app.request(`/v1/threads/${offerBody.clause.thread}/leave`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(leave.status).toBe(400);
  });

  it("a guest cannot leave a thread", async () => {
    const { thread } = await deliver("you@house", ["ben@house"], "the tempest", "the storm is coming");
    const res = await app.request(`/v1/threads/${thread}/leave`, {
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  it("a non-participant cannot leave a thread — absence is silence", async () => {
    const { thread } = await deliver("you@house", ["ben@house"], "the tempest", "the storm is coming");
    const res = await app.request(`/v1/threads/${thread}/leave`, {
      method: "POST",
      headers: { Authorization: basic("sam@house", "samsamsam") },
    });
    expect(res.status).toBe(404);
  });
});
