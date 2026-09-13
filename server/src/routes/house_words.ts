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

export function createHouseWordsRoutes(
  house: House,
  caller: (c: any) => Promise<Authenticated | null>,
  auth: AuthService | undefined,
  invites: InviteService | undefined,
  book: BookService | undefined,
  limiters: any
) {
  const app = new Hono();

  // The serif voice's names for the rooms (SPEC §5 #14). The addresses are
  // protocol-stable (@house, pub@house, book@house); the words on the page
  // are the community's. A residential request answers with the house's
  // self-regard so the client can render its own rooms by name — an
  // Islamic community calls them what it calls them. No sensitive state.
  app.get("/v1/house/meta", async (c) => {
    const who = await caller(c);
    // Keyless by default: the house's own words are public branding, so the
    // keyless door can greet a community by its own name. HOUSE_META_PUBLIC=0
    // makes the read keyed again — a keyless request then answers the door's
    // silence, and the door falls back to the founding vocabulary.
    if (!house.config.houseMetaPublic && !who) {
      return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    }
    return c.json({
      houseName: house.config.houseName,
      pubName: house.config.pubName,
      bookName: house.config.bookName,
      mailboxName: house.config.mailboxName,
      archiveName: house.config.archiveName,
      addressesName: house.config.addressesName,
      profileName: house.config.profileName,
      writeName: house.config.writeName,
      whisperName: house.config.whisperName,
      dayName: house.config.dayName,
      domain: house.config.houseDomain,
      // Whether the house offers a provider door — the login shows the
      // provider button only when it does. No sensitive state.
      oidcEnabled: Boolean(auth && auth.oidcEnabled),
      // The house's public halves (SPEC §15, second model) — the
      // composer seals *with* the house by including house@house in
      // the recipients; the house opens only the collaborative letters
      // it is party to. Public keys are public.
      houseAgeRecipient: (await house.houseKeys.get())?.ageRecipient ?? null,
      houseEd25519Public: (await house.houseKeys.get())?.ed25519Public ?? null,
      houseAddress: "house@house",
    });
  });

  return app;
}
