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

export function createThreadsRoutes(
  house: House,
  caller: (c: any) => Promise<Authenticated | null>,
  auth: AuthService | undefined,
  invites: InviteService | undefined,
  book: BookService | undefined,
  limiters: any
) {
  const app = new Hono();

  // Threads are correspondences. The thread is the unit, not the message.
  // Private by default: only participants may read a thread, and only
  // threads the caller is currently 'in' — a leaver's edges dissolve.
  app.get("/v1/threads/:id", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const threadId = c.req.param("id");
    const letters = await house.repo.listThread(threadId);
    const state = await house.repo.participationStates([threadId], who.address);
    const visible = filterVisible(letters, who.address, state);
    if (visible.length === 0) {
      return c.json({ error: { code: "not_found", message: "no such thread" } }, 404);
    }
    return c.json({
      thread: threadId,
      participation: state.get(threadId) ?? "in",
      letters: visible.map(toLetter),
    });
  });

  // Leave a thread — the structural stop. The act IS a letter; the archive
  // keeps the history; participation is derived. The leaver's edges
  // dissolve — visibility prunes itself. The book is exempt: clause
  // threads are commons by right — you cannot leave the household's
  // knowing of itself.
  app.post("/v1/threads/:id/leave", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const threadId = c.req.param("id");
    const letters = await house.repo.listThread(threadId);
    const state = await house.repo.participationStates([threadId], who.address);
    const visible = filterVisible(letters, who.address, state);
    if (visible.length === 0) {
      return c.json({ error: { code: "not_found", message: "no such thread" } }, 404);
    }
    if (letters.some((l) => l.kind === "clause")) {
      return c.json(
        { error: { code: "invalid_leave", message: "the book is commons by right — you cannot leave it" } },
        400,
      );
    }
    const { letterId, state: newState } = await house.participation.act(who.address, threadId, "leave");
    return c.json({ id: letterId, thread: threadId, participation: newState }, 201);
  });

  // Rejoin a thread — the historical edges stand again. The act IS a
  // letter; the archive keeps the history; participation is derived.
  app.post("/v1/threads/:id/join", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const threadId = c.req.param("id");
    const letters = await house.repo.listThread(threadId);
    if (letters.length === 0) {
      return c.json({ error: { code: "not_found", message: "no such thread" } }, 404);
    }
    if (letters.some((l) => l.kind === "clause")) {
      return c.json(
        { error: { code: "invalid_join", message: "the book is commons by right — you are always party to it" } },
        400,
      );
    }
    const { letterId, state: newState } = await house.participation.act(who.address, threadId, "join");
    return c.json({ id: letterId, thread: threadId, participation: newState }, 201);
  });

  // Put away a thread — the shelf (migration 025). The resident keeps the
  // thread: the edges stand, the letters stay readable from the archive,
  // and the house stops offering it in the mailbox and the whisper —
  // until it is brought back. Gentler than leave: leaving dissolves the
  // edges; shelving shelves the correspondence. The act IS a letter; the
  // archive keeps the history; participation is derived. The book is
  // exempt: clause threads are commons by right.
  app.post("/v1/threads/:id/shelve", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const threadId = c.req.param("id");
    const letters = await house.repo.listThread(threadId);
    if (letters.length === 0) {
      return c.json({ error: { code: "not_found", message: "no such thread" } }, 404);
    }
    if (letters.some((l) => l.kind === "clause")) {
      return c.json(
        { error: { code: "invalid_shelve", message: "the book is commons by right — you cannot put it away" } },
        400,
      );
    }
    const { letterId, state: newState } = await house.participation.act(who.address, threadId, "shelve");
    return c.json({ id: letterId, thread: threadId, participation: newState }, 201);
  });

  // Bring a thread back from the shelf — the edges stood the whole time.
  app.post("/v1/threads/:id/unshelve", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const threadId = c.req.param("id");
    const letters = await house.repo.listThread(threadId);
    if (letters.length === 0) {
      return c.json({ error: { code: "not_found", message: "no such thread" } }, 404);
    }
    if (letters.some((l) => l.kind === "clause")) {
      return c.json(
        { error: { code: "invalid_unshelve", message: "the book is commons by right — it is never put away" } },
        400,
      );
    }
    const { letterId, state: newState } = await house.participation.act(who.address, threadId, "unshelve");
    return c.json({ id: letterId, thread: threadId, participation: newState }, 201);
  });

  // Scrub a thread — the safety move (SPEC §19). Deletes every letter the
  // caller is party to in the thread, plus the thread, payloads, qdrant
  // points, and whispers pointing at it. The pipeline cascades deletes
  // across all three tiers. Unilateral and immediate: the resident does
  // not need anyone's consent to stop being seen as who they were. The
  // other party's letters in the same thread stay — the house cannot
  // delete what the resident does not own — but the resident's view of
  // the thread is gone either way (visibility is participant-derived).
  // The book is exempt: clause threads are commons by right.
  app.post("/v1/threads/:id/scrub", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const threadId = c.req.param("id");
    const letters = await house.repo.listThread(threadId);
    if (letters.length === 0) {
      return c.json({ error: { code: "not_found", message: "no such thread" } }, 404);
    }
    if (letters.some((l) => l.kind === "clause")) {
      return c.json(
        { error: { code: "invalid_scrub", message: "the book is commons by right — you cannot scrub it" } },
        400,
      );
    }
    const mine = await house.repo.listThreadForAddress(threadId, who.address);
    if (mine.length === 0) {
      return c.json({ error: { code: "not_found", message: "no such thread" } }, 404);
    }
    let deleted = 0;
    for (const letter of mine) {
      const removed = await house.pipeline.delete(letter.id);
      if (removed) deleted += 1;
    }
    // The other party's letters stay, but the resident is no longer party
    // to them. Leaving is the house's own structural stop: the act IS a
    // letter, participation flips to 'out', and visibility prunes itself —
    // the view is gone even though the words remain. The leave letter is
    // the archive's honest record of the act.
    await house.participation.act(who.address, threadId, "leave");
    // Whispers pointing at the thread die with it — the house stops
    // offering a correspondence that no longer exists for this resident.
    await house.whisper.deleteForThread(threadId).catch((err) => {
      house.log.error("whisper:scrub-cleanup-failed", {
        threadId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
    return c.json({ scrubbed: true, thread: threadId, deleted });
  });

  return app;
}
