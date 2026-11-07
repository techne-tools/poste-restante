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
import { addressTag } from "../pipeline/logger.js";
import { mayAnswerKeyOffer } from "../keyletter.js";

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

  // ── A keyletter's offered key change (SPEC §15, migration 034) ──────────
  //
  // A keyletter from an address whose live key DIFFERS does not overwrite the
  // record: everyone who already sealed a letter to the old key needs to see
  // that it moved. The change waits as one pending offer per address, and a
  // human answers it here — accept (the offer becomes the live key) or
  // decline (the record stands; the letter stays in the archive).
  //
  // Who may answer: the address itself, or anyone who can see the keyletter
  // that carried the change. Visibility is derived, not granted — a resident
  // who is not party to the letter is answered exactly as if no offer existed
  // (AGENTS.md privacy checklist #2 and #8).
  //
  // Accepting does NOT move `identity_id`: the key arrived by TOFU and a human
  // agreeing it is current does not make it the address's proven identity.
  // That happens only when the address registers with proof of possession.
  const answerOffer = async (c: any, answer: "accept" | "decline") => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const address = c.req.param("address");
    const body = (await c.req.json().catch(() => null)) as { letterId?: string } | null;
    const letterId = body?.letterId?.trim();
    if (!letterId) {
      return c.json(
        { error: { code: "invalid_offer_answer", message: "say which keyletter you are answering" } },
        400,
      );
    }
    const offer = await house.repo.getKeyOffer(address);
    if (!offer) {
      return c.json({ error: { code: "not_found", message: "no such key change" } }, 404);
    }
    // Who is asking, before what they are asking about. A non-party must not be
    // able to tell an offer apart from its absence — including by sending a
    // letter id that does not match (which would otherwise answer 409 and say
    // "an offer exists here"). Absence is silence, in every branch.
    const party = await mayAnswerKeyOffer(house.repo, who.address, address, letterId);
    if (!party) {
      return c.json({ error: { code: "not_found", message: "no such key change" } }, 404);
    }
    if (offer.letter_id !== letterId) {
      // The resident answered an offer that has since been replaced by a newer
      // keyletter. Accepting the older keys would install what they did not
      // just read, so the house says so instead.
      return c.json(
        {
          error: {
            code: "stale_offer",
            message: "the key change has been replaced — read it again before answering",
          },
        },
        409,
      );
    }
    if (answer === "accept") {
      await house.repo.setAddressKey(
        address,
        {
          ageRecipient: offer.age_recipient,
          ed25519Public: offer.ed25519_public,
          recoveryAgeRecipient: offer.recovery_age_recipient,
        },
        "keyletter",
        offer.letter_id,
      );
    }
    await house.repo.resolveKeyOffer(address, answer === "accept" ? "accepted" : "declined");
    // Log the decision, never the person: a hashed address tag and the letter
    // id (a content hash).
    house.log.info(answer === "accept" ? "keys:keyletter-accepted" : "keys:keyletter-declined", {
      addressTag: addressTag(address),
      letterId,
      by: addressTag(who.address),
    });
    return c.json({
      address,
      letterId,
      accepted: answer === "accept",
      key: await house.repo.getAddressKey(address),
    });
  };

  app.post("/v1/addresses/:address/keys/offer/accept", (c) => answerOffer(c, "accept"));
  app.post("/v1/addresses/:address/keys/offer/decline", (c) => answerOffer(c, "decline"));

  return app;
}
