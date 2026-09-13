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

export function createWhisperRoutes(
  house: House,
  caller: (c: any) => Promise<Authenticated | null>,
  auth: AuthService | undefined,
  invites: InviteService | undefined,
  book: BookService | undefined,
  limiters: any
) {
  const app = new Hono();

  // The whisper — the mailbox for the house's own letters. A GET resource.
  // Nothing pushes; the client comes for it. `?unread=1` shows only what the
  // house is offering right now. Scoped to the caller: the house only
  // whispers about correspondence the caller is party to.
  app.get("/v1/whisper", limiters.whisperLimiter, async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const unread = c.req.query("unread") === "1" || c.req.query("unread") === "true";
    const limitRaw = c.req.query("limit");
    let limit = 50;
    if (limitRaw) {
      limit = Number.parseInt(limitRaw, 10);
      if (Number.isNaN(limit) || limit < 1) {
        return c.json(
          { error: { code: "invalid_limit", message: "limit must be a positive integer" } },
          400,
        );
      }
      limit = Math.min(limit, MAX_LIMIT);
    }
    const whispers = unread
      ? await house.whisper.listUnread(who.address, limit)
      : await house.whisper.list(who.address, limit);
    return c.json({ whispers });
  });

  // The user opened a whisper. A signal, not a notification. Scoped: you can
  // only open a whisper about a thread you are party to.
  app.post("/v1/whisper/:id/open", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const ok = await house.whisper.open(c.req.param("id"), who.address);
    if (!ok) {
      return c.json({ error: { code: "not_found", message: "no such whisper" } }, 404);
    }
    return c.json({ opened: true, id: c.req.param("id") });
  });

  // Explicit dismissal — the strongest negative signal. The house takes
  // corrections at face value; undismiss is always possible. Scoped.
  app.post("/v1/whisper/:id/dismiss", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const ok = await house.whisper.dismiss(c.req.param("id"), who.address);
    if (!ok) {
      return c.json({ error: { code: "not_found", message: "no such whisper" } }, 404);
    }
    return c.json({ dismissed: true, id: c.req.param("id") });
  });

  app.post("/v1/whisper/:id/undismiss", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const ok = await house.whisper.undismiss(c.req.param("id"), who.address);
    if (!ok) {
      return c.json({ error: { code: "not_found", message: "no such whisper" } }, 404);
    }
    return c.json({ dismissed: false, id: c.req.param("id") });
  });

  // Gap detection — cheap structural checks (dormant threads, unanswered
  // questions). Runs on demand; the house never pushes the results. Scoped
  // to the caller: gaps are only offered for threads the caller is party to.
  app.post("/v1/whisper/gaps", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const created = await house.whisper.detectGaps(who.address);
    return c.json({ created: created.map((w) => w.id) });
  });

  return app;
}
