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

export function createAddressesRoutes(
  house: House,
  caller: (c: any) => Promise<Authenticated | null>,
  auth: AuthService | undefined,
  invites: InviteService | undefined,
  book: BookService | undefined,
  limiters: any
) {
  const app = new Hono();

  // The address book — the social graph. Flat, no ranking, no follower counts.
  // Authenticated residents may read it; the pub is public.
  app.get("/v1/addresses", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const addresses = await house.repo.listAddresses();
    return c.json({ addresses });
  });

  app.get("/v1/addresses/:address", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const address = await house.repo.getAddress(c.req.param("address"));
    if (!address) {
      return c.json({ error: { code: "not_found", message: "no such address" } }, 404);
    }
    return c.json(address);
  });

  // Correct the address book. The house takes corrections at face value.
  // Only the address itself may correct its own entry.
  app.patch("/v1/addresses/:address", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const address = c.req.param("address");
    if (address !== who.address) {
      return c.json({ error: { code: "forbidden", message: "you may only correct your own address" } }, 403);
    }
    const existing = await house.repo.getAddress(address);
    if (!existing) {
      return c.json({ error: { code: "not_found", message: "no such address" } }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "invalid_json", message: "the correction must be JSON" } },
        400,
      );
    }
    const parsed = AddressSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "invalid_address",
            message: "names must be a list; pronouns are free text",
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }
    await house.repo.updateAddress(
      address,
      parsed.data.names,
      parsed.data.pronouns,
      // A names/pronouns correction must not reset the desk's default.
      parsed.data.sealDefault ?? existing.sealDefault,
    );
    return c.json(await house.repo.getAddress(address));
  });

  // The mailbox — pull by default. Nothing pushes; the letter waits.
  // Private by default: you may read your own mailbox. The pub's door is
  // schema — an unauthenticated reader is admitted only while the room's
  // is_public door is open. A closed pub answers exactly like any private
  // mailbox: 401, the absence of a visitor, not a denial (a member knows
  // the pub exists; absence is silence, not accusation).
  app.get("/v1/addresses/:address/inbox", async (c) => {
    const address = c.req.param("address");
    const existing = await house.repo.getAddress(address);
    if (!existing) {
      return c.json({ error: { code: "not_found", message: "no such address" } }, 404);
    }
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
    const who = await caller(c);
    if (!who) {
      // No credential. The only rooms open to a visitor are the ones left
      // open: addresses.is_public (the pub, while its door is open).
      if (!isPublicAddress(existing)) {
        return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
      }
    } else if (address !== who.address && address !== PUB_ADDRESS) {
      // A resident reads their own mailbox, or the house's public room.
      return c.json({ error: { code: "not_found", message: "no such address" } }, 404);
    }
    const letters = await house.repo.listMailbox(address, limit);
    return c.json({ address, letters: letters.map(toLetter) });
  });

  // The review — what the house holds about you (SPEC §19). Deletion is
  // first-class and already built; this is the quiet "look at your
  // record" surface: every letter the caller is party to, including the
  // ones on the shelf (a letter put away is still held by the house),
  // newest first, capped high enough to be a record. Only the resident
  // themselves may look — this is self-regard, not administration.
  app.get("/v1/addresses/:address/review", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const address = c.req.param("address");
    if (address !== who.address) {
      return c.json({ error: { code: "forged", message: "you can only review what the house holds about you" } }, 403);
    }
    const letters = await house.repo.listLettersForReview(address);
    return c.json({ address, letters: letters.map(toLetter) });
  });

  return app;
}
