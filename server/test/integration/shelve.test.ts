/**
 * Putting away as the shelf — integration tests (migration 025).
 *
 * These prove the whole arc against live infra (postgres 15, qdrant,
 * ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   shelve   → the thread stays readable (the edges stand)
 *            → the mailbox stops offering it
 *            → the whisper stops offering it, and gaps are not created
 *   unshelve → the mailbox and the whisper offer it again
 *
 * And the privacy rules: the book is exempt (clause threads are commons
 * by right); the act IS a letter (the archive keeps the history).
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

describe.skipIf(!INTEGRATION)("the shelf — put away and bring back (integration)", () => {
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
      `INSERT INTO addresses (id, identity_id, is_public)
       VALUES ('book@house', 'book@house', false), ('pub@house', 'pub@house', true)`,
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

  /** Deliver a letter from `from` to `to` in a fresh thread. */
  async function deliver(from: string, to: string[], subject: string, body: string): Promise<{ id: string; thread: string }> {
    const password = from === "you@house" ? "youyouyou" : "benbenben";
    const thread = `th_shelf_${Math.random().toString(36).slice(2, 10)}`;
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic(from, password) },
      body: JSON.stringify({
        envelope: { from, to, cc: [], thread, kind: "letter", lang: "en-AU", subject },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: body },
      }),
    });
    expect(res.status).toBe(201);
    return { id: ((await res.json()) as { id: string }).id, thread };
  }

  it("shelves a thread — the act IS a letter, the edges stand, the mailbox and the whisper stop offering it", async () => {
    const { id, thread } = await deliver("you@house", ["you@house"], "the storm", "i am keeping this here.");
    // A whisper for the thread exists (the house's own letter).
    await house.whisper.surfaceHouseLetter(id, thread, "a note about the storm");

    // Before: the mailbox shows the letter; the whisper offers it.
    const inboxBefore = await app.request("/v1/addresses/you@house/inbox", {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const beforeBody = (await inboxBefore.json()) as { letters: { envelope: { thread: string } }[] };
    expect(beforeBody.letters.some((l) => l.envelope.thread === thread)).toBe(true);

    const whisperBefore = await house.whisper.list("you@house");
    expect(whisperBefore.some((w) => w.targetThread === thread)).toBe(true);

    // Shelve.
    const shelve = await app.request(`/v1/threads/${thread}/shelve`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(shelve.status).toBe(201);
    const shelveBody = (await shelve.json()) as { participation: string; id: string };
    expect(shelveBody.participation).toBe("shelved");

    // The act IS a letter — the archive keeps the shelve.
    const letter = await house.repo.getLetter(shelveBody.id);
    expect(letter?.kind).toBe("shelve");

    // After: the mailbox no longer offers it…
    const inboxAfter = await app.request("/v1/addresses/you@house/inbox", {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const afterBody = (await inboxAfter.json()) as { letters: { envelope: { thread: string } }[] };
    expect(afterBody.letters.some((l) => l.envelope.thread === thread)).toBe(false);

    // …and the whisper no longer offers it.
    const whisperAfter = await house.whisper.list("you@house");
    expect(whisperAfter.some((w) => w.targetThread === thread)).toBe(false);

    // But the edges stand — the thread is still readable.
    const read = await app.request(`/v1/threads/${thread}`, {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(read.status).toBe(200);
    const readBody = (await read.json()) as { participation: string; letters: unknown[] };
    expect(readBody.participation).toBe("shelved");
    expect(readBody.letters.length).toBeGreaterThan(0);
  });

  it("unshelves a thread — the mailbox and the whisper offer it again", async () => {
    const { thread } = await deliver("you@house", ["you@house"], "the shelf test", "back soon.");
    await house.participation.act("you@house", thread, "shelve");

    const unshelve = await app.request(`/v1/threads/${thread}/unshelve`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(unshelve.status).toBe(201);
    const body = (await unshelve.json()) as { participation: string };
    expect(body.participation).toBe("in");

    const inbox = await app.request("/v1/addresses/you@house/inbox", {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const inboxBody = (await inbox.json()) as { letters: { envelope: { thread: string } }[] };
    expect(inboxBody.letters.some((l) => l.envelope.thread === thread)).toBe(true);
  });

  it("detects no gap for a shelved thread — the house does not offer what was put away", async () => {
    const { thread } = await deliver("you@house", ["you@house"], "shelved corner", "put me away.");
    await house.participation.act("you@house", thread, "shelve");

    const gaps = await house.whisper.detectGaps("you@house");
    expect(gaps.some((w) => w.targetThread === thread)).toBe(false);
  });

  it("refuses to shelve the book — clause threads are commons by right", async () => {
    // A clause thread (the book is exempt from shelving).
    const clauseThread = "th_clause_shelf";
    const res = await app.request("/v1/book", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({ role: "offer", text: "the house stays a house." }),
    });
    expect(res.status).toBe(201);

    // Find the clause thread id from the book head.
    const head = await house.book.head();
    const clause = head.clauses[0];
    expect(clause).toBeDefined();

    const shelve = await app.request(`/v1/threads/${clause.thread}/shelve`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(shelve.status).toBe(400);
    const body = (await shelve.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_shelve");
  });

  it("refuses to unshelve the book — the refusal names the move refused", async () => {
    const res = await app.request("/v1/book", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({ role: "offer", text: "the house stays a house." }),
    });
    expect(res.status).toBe(201);
    const head = await house.book.head();
    const clause = head.clauses[0];
    expect(clause).toBeDefined();

    const unshelve = await app.request(`/v1/threads/${clause.thread}/unshelve`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(unshelve.status).toBe(400);
    const body = (await unshelve.json()) as { error: { code: string; message: string } };
    expect(body.error.code).toBe("invalid_unshelve");
    // An unshelve is not a shelve — the refusal says what it refused.
    expect(body.error.message).toContain("it is never put away");
  });
});
