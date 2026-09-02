/**
 * The whisper's citation of the book — integration tests against live
 * infra (postgres 15, qdrant, ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 * The arc:
 *
 *   a clause stands → a gap whisper whose summary shares ground
 *     → the whisper cites the clause ("the household has held this")
 *   a gap whisper with no shared ground → no citation
 *
 * And the privacy rule: the book is commons by right, so the citation
 * leaks nothing — the resident already holds the book by right.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import { BookService, PUB_DOOR } from "../../src/book/service.js";
import type { House } from "../../src/house.js";
import type { Letter } from "../../src/types.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("whisper citation (integration)", () => {
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
              thread_participation, letters, threads, frames, addresses, credentials
       RESTART IDENTITY CASCADE`,
    );
    await house.db.pool.query(
      `INSERT INTO addresses (id, is_public) VALUES ('book@house', false), ('pub@house', true)`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth);
    await auth.setPassword("you@house", "youyouyou");
    await auth.setPassword("ben@house", "benbenben");
    book = new BookService(house.db.pool, house.pipeline, house.repo, house.log, 7);
    app = createLetterServer(house, { auth, book });
  });

  afterAll(async () => {
    await house.close();
  });

  /** Deliver a letter through the pipeline (the single write path). */
  async function deliver(
    from: string,
    to: string[],
    thread: string,
    subject: string,
    content: string,
    daysAgo = 0,
  ): Promise<string> {
    const letter: Letter = {
      envelope: {
        from,
        to,
        cc: [],
        thread,
        kind: "letter",
        lang: "en-AU",
        subject,
      },
      time: {
        gregorian: new Date(Date.now() - daysAgo * 86_400_000).toISOString(),
        frames: [],
      },
      body: { format: "markdown", content },
    };
    const { letterId } = await house.pipeline.ingest(letter);
    if (daysAgo > 0) {
      await house.db.pool.query(
        `UPDATE letters SET received_at = received_at - interval '${daysAgo} days' WHERE id = $1`,
        [letterId],
      );
    }
    return letterId;
  }

  it("a gap whisper cites a standing clause that shares ground", async () => {
    // A clause stands: "the pub closes at dusk" — the household has held it.
    const offer = await app.request("/v1/book", {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        role: "offer",
        text: "the pub closes at dusk",
        binding: { door: PUB_DOOR, value: false },
      }),
    });
    expect(offer.status).toBe(201);
    const offerBody = (await offer.json()) as { clause: { thread: string } };
    const clauseThread = offerBody.clause.thread;
    // Fast-forward the settling clock so the clause stands.
    await house.db.pool.query(
      `UPDATE letters SET received_at = received_at - interval '8 days'
       WHERE thread_id = $1 AND kind = 'clause'`,
      [clauseThread],
    );
    const head = await book.head();
    expect(head.clauses[0]!.state).toBe("standing");

    // A correspondence that shares the clause's ground — the thread's
    // latest subject names the same matter, so the whisper's summary
    // (which carries that subject) will stand close to the clause text.
    const thread = "th_cite_pub";
    await deliver("you@house", ["ben@house"], thread, "the pub closes at dusk", "the pub closes at dusk", 20);
    await deliver("ben@house", ["you@house"], thread, "the pub closes at dusk", "yes — the pub closes at dusk", 18);

    const gaps = await house.whisper.detectGaps("you@house");
    const dormant = gaps.find((g) => g.kind === "gap-dormant-thread" && g.targetThread === thread);
    expect(dormant).toBeDefined();
    expect(dormant!.citedClause).toBe(clauseThread);
    expect(dormant!.citedExcerpt).toContain("the pub closes at dusk");

    // The citation is persisted — a fresh read sees it.
    const listed = await house.whisper.list("you@house");
    const persisted = listed.find((w) => w.id === dormant!.id);
    expect(persisted!.citedClause).toBe(clauseThread);
  });

  it("a gap whisper with no shared ground carries no citation", async () => {
    // A correspondence about the garden — nothing the household has held.
    const thread = "th_cite_garden";
    await deliver("you@house", ["ben@house"], thread, "the garden grows", "the garden grows well this season", 20);
    await deliver("ben@house", ["you@house"], thread, "the garden grows", "the tomatoes are coming in", 18);

    const gaps = await house.whisper.detectGaps("you@house");
    const dormant = gaps.find((g) => g.kind === "gap-dormant-thread" && g.targetThread === thread);
    expect(dormant).toBeDefined();
    expect(dormant!.citedClause).toBeNull();
    expect(dormant!.citedExcerpt).toBeNull();
  });

  it("a proposed clause is not citable — only standing is held", async () => {
    // A fresh offer, still before the household.
    const offer = await app.request("/v1/book", {
      method: "POST",
      headers: { Authorization: basic("ben@house", "benbenben") },
      body: JSON.stringify({ role: "offer", text: "the house keeps a quiet hour" }),
    });
    expect(offer.status).toBe(201);

    const thread = "th_cite_quiet";
    await deliver("you@house", ["ben@house"], thread, "the house keeps a quiet hour", "the house keeps a quiet hour", 20);
    await deliver("ben@house", ["you@house"], thread, "the house keeps a quiet hour", "yes — a quiet hour", 18);

    const gaps = await house.whisper.detectGaps("you@house");
    const dormant = gaps.find((g) => g.kind === "gap-dormant-thread" && g.targetThread === thread);
    expect(dormant).toBeDefined();
    // The proposed clause is still before the household — not held, not cited.
    expect(dormant!.citedClause).toBeNull();
  });
});
