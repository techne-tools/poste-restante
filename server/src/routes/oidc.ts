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

export function createOidcRoutes(
  house: House,
  caller: (c: any) => Promise<Authenticated | null>,
  auth: AuthService | undefined,
  invites: InviteService | undefined,
  book: BookService | undefined,
  limiters: any
) {
  const app = new Hono();

  // Start the OIDC dance. Returns the provider URL; the client redirects.
  app.get("/v1/auth/oidc/start", limiters.oidcLimiter, async (c) => {
    if (!auth || !auth.oidcEnabled) {
      return c.json({ error: { code: "oidc_disabled", message: "OIDC is not configured" } }, 400);
    }
    const { url, verifier, state } = await auth.oidcStart();
    limiters.oidcPending.set(state, { verifier, state, expiresAt: Date.now() + limiters.OIDC_TTL_MS });
    return c.json({ url, state });
  });

  // The provider redirects the BROWSER here with ?code=&state=. Verify, then
  // hand the browser back to the client door with the outcome in the URL
  // fragment — the resident returns to a designed surface, never a JSON stub.
  // A fragment is never sent to a server, and the client clears it on arrival.
  //
  // The client origin is derived from the configured redirect URI (the
  // operator points OIDC_REDIRECT_URI at the client origin's /v1 path).
  const oidcClientBase = (): string => {
    const redirect = house.config.auth.oidc?.redirectUri;
    if (!redirect) return "/";
    try {
      return `${new URL(redirect).origin}/`;
    } catch {
      return "/";
    }
  };
  app.get("/v1/auth/oidc/callback", async (c) => {
    const base = oidcClientBase();
    const fail = (message: string) =>
      c.redirect(`${base}#oidc_error=${encodeURIComponent(message)}`);
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) return fail("the provider did not return a code");
    const pending = limiters.oidcPending.get(state);
    if (!pending || pending.expiresAt < Date.now()) {
      return fail("this attempt at the door has expired — start again");
    }
    limiters.oidcPending.delete(state);
    if (!auth) return fail("OIDC is not configured in this house");
    try {
      const { address } = await auth.oidcCallback(code, pending.verifier);
      // A verified identity gets an opaque bearer token (the house stores
      // only its hash) — but never at the cost of a password: an address
      // that keeps a password keeps it, and the door says so.
      const token = await auth.issueOidcToken(address);
      if (!token) return fail("this identity already keeps a password — sign in with it");
      return c.redirect(
        `${base}#oidc=${encodeURIComponent(token)}&address=${encodeURIComponent(address)}`,
      );
    } catch (err) {
      house.log.warn("oidc:callback-failed", {
        message: err instanceof Error ? err.message : String(err),
      });
      return fail("the house could not verify this identity");
    }
  });

  // Construct an invitation — the resident's own door opening (SPEC §5.7).
  // A resident mints a dormant address and writes the invite letter; the
  // one-time code is shown once and stored only as a hash. The guest is
  // told about the letter out of band — the house never pushes.
  app.post("/v1/invites", async (c) => {
    if (!invites) {
      return c.json({ error: { code: "not_found", message: "no such thing in the house" } }, 404);
    }
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ error: { code: "invalid_json", message: "the invitation must be JSON" } }, 400);
    }
    const parsed = InviteSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "invalid_invite",
            message: "the invitation needs an address for the guest",
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }
    try {
      const minted = await invites.mint(who.address, parsed.data.address);
      house.log.info("invite:minted", { by: who.address, to: minted.address });
      // The code is shown once, never stored — the client holds it in memory
      // long enough to display, then it is gone from the wire.
      return c.json(
        { address: minted.address, createdBy: minted.createdBy, code: minted.code, letterId: minted.letterId },
        201,
      );
    } catch (err) {
      return c.json(
        {
          error: {
            code: "invalid_invite",
            message: err instanceof Error ? err.message : "the house could not write this invitation",
          },
        },
        400,
      );
    }
  });

  // Redeem an invite — the guest's door into the house. Public, like the
  // health check: the whole point is that a guest has no credential yet.
  // Proves possession of the invite letter (address is a participant) and
  // the one-time code; the house issues the credential the guest sets
  // themselves. Fail closed: every negative path answers 404, never 403,
  // and never confirms that an invite exists. Absence is silence.
  app.post("/v1/invites/redeem", limiters.redeemLimiter, async (c) => {
    if (!invites) {
      return c.json({ error: { code: "not_found", message: "no such thing in the house" } }, 404);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "invalid_json", message: "the letter must be JSON" } },
        400,
      );
    }
    const parsed = RedeemSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "invalid_redeem",
            message: "the redemption does not match the contract",
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }
    const redeemed = await invites.redeem(parsed.data);
    if (!redeemed) {
      // Absence is silence: wrong code, wrong address, spent, expired, or
      // already a resident — the house never says which.
      return c.json({ error: { code: "not_found", message: "no such thing in the house" } }, 404);
    }
    house.log.info("invite:redeemed", { address: redeemed.address });
    return c.json({ address: redeemed.address, joined: true }, 201);
  });

  return app;
}
