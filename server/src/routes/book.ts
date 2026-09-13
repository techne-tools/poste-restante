import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { createRateLimiter } from "../auth/rate-limiter.js";
import { LETTER_KINDS } from "../types.js";
import { AddressSchema, LetterSchema, RedeemSchema, ChangePasswordSchema, RegisterKeysSchema, ClauseActionSchema, DayCardSchema, InviteSchema, toLetter } from "../schemas.js";
import { deliverLetter } from "../deliver.js";
import type { House } from "../house.js";
import type { RetrievalQuery } from "../retrieval/retrieval.js";
import type { AuthService, Authenticated } from "../auth/service.js";
import { isVisibleTo, isPublicAddress, visibleToSql, filterVisible, PUB_ADDRESS } from "../auth/visibility.js";
import type { InviteService } from "../invites/service.js";
import type { BookService } from "../book/service.js";
import { BOOK_ADDRESS } from "../book/service.js";
import type { OidcPending } from "../server.js";
import { MAX_LIMIT, DEFAULT_LIMIT } from "../server.js";

export function createBookRoutes(
  house: House,
  caller: (c: any) => Promise<Authenticated | null>,
  auth: AuthService | undefined,
  invites: InviteService | undefined,
  book: BookService | undefined,
  limiters: any
) {
  const app = new Hono();

  // The book's head — the derived constitution. Commons by right: every
  // resident reads it. The book is NOT a keyless door — guests are not
  // residents; the book is the household's knowing of itself.
  app.get("/v1/book", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    if (!book) return c.json({ error: { code: "not_found", message: "no such thing in the house" } }, 404);
    const head = await book.head();
    return c.json(head);
  });

  // Read one clause thread — the correspondence is the develop.
  app.get("/v1/book/threads/:id", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    if (!book) return c.json({ error: { code: "not_found", message: "no such thing in the house" } }, 404);
    const threadId = c.req.param("id");
    const letters = await house.repo.listThread(threadId);
    const clauseLetters = letters.filter((l) => l.kind === "clause");
    if (clauseLetters.length === 0) {
      return c.json({ error: { code: "not_found", message: "no such clause" } }, 404);
    }
    return c.json({ thread: threadId, letters: clauseLetters.map(toLetter) });
  });

  // Perform an act — the act IS a letter to the book. The house enforces
  // stated will: the role is declared, never guessed from the prose.
  app.post("/v1/book", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    if (!book) return c.json({ error: { code: "not_found", message: "no such thing in the house" } }, 404);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "invalid_json", message: "the act must be JSON" } },
        400,
      );
    }
    const parsed = ClauseActionSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "invalid_clause",
            message: "the act does not match the contract",
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }
    const action = parsed.data;
    // An offer opens a thread; every other role continues one.
    if (action.role !== "offer" && !action.continues) {
      return c.json(
        { error: { code: "invalid_clause", message: "this act needs a thread to continue" } },
        400,
      );
    }
    // An offer needs text — the norm itself.
    if (action.role === "offer" && !action.text?.trim()) {
      return c.json(
        { error: { code: "invalid_clause", message: "an offer needs the clause text" } },
        400,
      );
    }
    // A develop needs text — the new wording.
    if (action.role === "develop" && !action.text?.trim()) {
      return c.json(
        { error: { code: "invalid_clause", message: "a develop needs the new text" } },
        400,
      );
    }
    try {
      const { letterId, clause } = await book.act(who.address, action);
      house.log.info("book:act", { role: action.role, thread: clause.thread, by: who.address });
      return c.json({ id: letterId, clause }, 201);
    } catch (err) {
      house.log.warn("book:act-failed", { message: err instanceof Error ? err.message : String(err) });
      return c.json(
        { error: { code: "invalid_clause", message: err instanceof Error ? err.message : "the book could not hold this act" } },
        400,
      );
    }
  });

  return app;
}
