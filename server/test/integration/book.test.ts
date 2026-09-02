/**
 * House book integration tests — the full protocol against live infra
 * (postgres 15, qdrant, ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 * These prove the whole arc:
 *
 *   offer → settle → bind the pub door → reverse → the door returns
 *
 * And the privacy rules: the book is commons by right (every resident reads
 * it), but it is NOT a keyless door — a guest gets 401, never the book.
 * Absence is silence; the book is the household's knowing of itself.
 *
 * The vocabulary is the household's own — consent-forward, not
 * parliamentary: offer, develop, stop (a safe word), support, set aside.
 * No and yes are equally significant.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import { BookService, BOOK_ADDRESS, PUB_DOOR } from "../../src/book/service.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("house book (integration)", () => {
  let house: House;
  let auth: AuthService;
  let book: BookService;
  let app: ReturnType<typeof createLetterServer>;

  beforeAll(async () => {
    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
      AUTH_MODE: "basic",
      BOOK_SETTLING_DAYS: "7",
    });
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    await house.db.pool.query(
      `TRUNCATE invites, whispers, clauses, clause_objectors, clause_vouchers,
              letters, threads, frames, addresses, credentials RESTART IDENTITY CASCADE`,
    );
    // The migration seeds book@house and pub@house; the TRUNCATE wiped them.
    // Re-seed exactly as the migration would — the book is a resident address
    // (commons by right, never keyless), the pub is open by default.
    await house.db.pool.query(
      `INSERT INTO addresses (id, is_public) VALUES ('book@house', false), ('pub@house', true)`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth);
    // Three residents: you (the owner), ben, sam.
    await auth.setPassword("you@house", "youyouyou");
    await auth.setPassword("ben@house", "benbenben");
    await auth.setPassword("sam@house", "samsamsam");
    book = new BookService(house.db.pool, house.pipeline, house.repo, house.log, 7);
    app = createLetterServer(house, { auth, book });
  });

  afterAll(async () => {
    await house.close();
  });

  it("the book is a resident address, seeded by the migration", async () => {
    const addr = await house.repo.getAddress(BOOK_ADDRESS);
    expect(addr).not.toBeNull();
    expect(addr!.is_public).toBe(false); // commons by right, never keyless
  });

  it("offers a clause — the act is a letter, the head derives it", async () => {
    const res = await app.request("/v1/book", {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        role: "offer",
        text: "the pub closes at dusk",
        binding: { door: PUB_DOOR, value: false },
      }),
    });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { id: string; clause: { state: string; thread: string; binding: { door: string; value: boolean } | null } };
    expect(body.clause.state).toBe("proposed");
    expect(body.clause.binding).toEqual({ door: PUB_DOOR, value: false });

    // The act IS a letter — kind clause, addressed to the book.
    const letter = await house.repo.getLetter(body.id);
    expect(letter!.kind).toBe("clause");
    expect(letter!.to_addrs).toContain(BOOK_ADDRESS);

    // The head shows the proposed clause.
    const head = await book.head();
    expect(head.clauses).toHaveLength(1);
    expect(head.clauses[0]!.state).toBe("proposed");
    expect(head.doors).toHaveLength(0); // not standing yet — no binding
  });

  it("a resident can support and stop — distinct voices", async () => {
    const head0 = await book.head();
    const thread = head0.clauses[0]!.thread;

    const support = await app.request("/v1/book", {
      method: "POST",
      headers: { Authorization: basic("ben@house", "benbenben") },
      body: JSON.stringify({ role: "support", continues: thread }),
    });
    expect(support.status).toBe(201);

    const stop = await app.request("/v1/book", {
      method: "POST",
      headers: { Authorization: basic("sam@house", "samsamsam") },
      body: JSON.stringify({ role: "stop", continues: thread }),
    });
    expect(stop.status).toBe(201);

    const head1 = await book.head();
    expect(head1.clauses[0]!.vouches).toBe(1);
    expect(head1.clauses[0]!.objections).toBe(1);
    expect(head1.clauses[0]!.state).toBe("contested");
  });

  it("setting aside the last stop restarts settling", async () => {
    const head0 = await book.head();
    const thread = head0.clauses[0]!.thread;

    const wd = await app.request("/v1/book", {
      method: "POST",
      headers: { Authorization: basic("sam@house", "samsamsam") },
      body: JSON.stringify({ role: "set aside", continues: thread }),
    });
    expect(wd.status).toBe(201);

    const head1 = await book.head();
    expect(head1.clauses[0]!.objections).toBe(0);
    expect(head1.clauses[0]!.state).toBe("proposed");
  });

  it("a clause stands after the settling period and binds the pub door", async () => {
    // Fast-forward the settling clock: the clause was proposed at now, so
    // we re-derive with a synthetic later time by rewriting the proposal's
    // received_at (the derivation reads the thread, not the cache).
    const head0 = await book.head();
    const thread = head0.clauses[0]!.thread;
    await house.db.pool.query(
      `UPDATE letters SET received_at = received_at - interval '8 days'
       WHERE thread_id = $1 AND kind = 'clause'`,
      [thread],
    );

    const head1 = await book.head();
    expect(head1.clauses[0]!.state).toBe("standing");
    expect(head1.doors).toEqual([
      { door: PUB_DOOR, value: false, boundBy: thread },
    ]);

    // The door is bound — the pub is closed to guests.
    const pub = await house.repo.getAddress("pub@house");
    expect(pub!.is_public).toBe(false);
  });

  it("the book is commons by right — every resident reads it", async () => {
    const res = await app.request("/v1/book", {
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { clauses: unknown[] };
    expect(body.clauses.length).toBeGreaterThan(0);
  });

  it("the book is NOT a keyless door — a guest gets 401", async () => {
    const res = await app.request("/v1/book");
    expect(res.status).toBe(401);
  });

  it("a reversal proposal that stands reverses the clause and the door", async () => {
    const head0 = await book.head();
    const thread = head0.clauses[0]!.thread;

    const rev = await app.request("/v1/book", {
      method: "POST",
      headers: { Authorization: basic("ben@house", "benbenben") },
      body: JSON.stringify({
        role: "offer",
        text: "the pub stays open",
        reverses: thread,
      }),
    });
    expect(rev.status).toBe(201);
    const revBody = (await rev.json()) as { clause: { thread: string } };
    const revThread = revBody.clause.thread;

    // Fast-forward the reversal's settling.
    await house.db.pool.query(
      `UPDATE letters SET received_at = received_at - interval '8 days'
       WHERE thread_id = $1 AND kind = 'clause'`,
      [revThread],
    );

    const head1 = await book.head();
    const reversed = head1.clauses.find((c) => c.thread === thread);
    expect(reversed!.state).toBe("reversed");
    expect(reversed!.reversedAt).not.toBeNull();
    // The reversal itself stands — "the pub stays open" is the current norm.
    const reversal = head1.clauses.find((c) => c.thread === revThread);
    expect(reversal!.state).toBe("standing");
    expect(reversal!.reversesThread).toBe(thread);

    // The door returns to its default — the pub is open again.
    const pub = await house.repo.getAddress("pub@house");
    expect(pub!.is_public).toBe(true);
    expect(head1.doors).toHaveLength(0);
  });

  it("an act without a thread to continue is refused", async () => {
    const res = await app.request("/v1/book", {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({ role: "stop" }),
    });
    expect(res.status).toBe(400);
  });

  it("an offer without text is refused", async () => {
    const res = await app.request("/v1/book", {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({ role: "offer" }),
    });
    expect(res.status).toBe(400);
  });

  it("a guest cannot act on the book", async () => {
    const res = await app.request("/v1/book", {
      method: "POST",
      body: JSON.stringify({ role: "offer", text: "the house is quiet" }),
    });
    expect(res.status).toBe(401);
  });
});
