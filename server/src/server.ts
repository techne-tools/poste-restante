/**
 * The letter server — the house's HTTP face. A thin client over the archive
 * spine (`buildHouse`). Speaks the CONTRACT: HTTP + JSON + markdown. Every
 * address is a resource; delivery is a POST to the letters collection; the
 * mailbox is a GET — pull by default, nothing pushes.
 *
 * House invariants enforced here:
 *   * Presence not pressure — there is NO push channel. No websocket, no SSE,
 *     no notification endpoint. The letter waits; the client comes for it.
 *   * Deletion is first-class — DELETE removes the letter from all three tiers
 *     (postgres, qdrant, FTS). No soft delete. The archive forgets on request.
 *   * The envelope has exactly the fields a letter needs. The id is derived
 *     from the envelope+body; a caller-supplied id is ignored.
 *   * No telemetry. The house logs locally; it never phones home.
 *   * Authentication is mandatory (AUTH_MODE). Identity = address: a
 *     credential is a capability to act as an address. Basic (scrypt) and
 *     OIDC (authorization code + PKCE) are both options.
 *   * Private by default: you read what you are party to. pub@house is the
 *     schema-level public exception. Absence is silence — 404, never 403.
 */
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import { createRateLimiter } from "./auth/rate-limiter.js";
import { LETTER_KINDS } from "./types.js";
import { AddressSchema, LetterSchema, RedeemSchema, ChangePasswordSchema, RegisterKeysSchema, ClauseActionSchema, DayCardSchema, InviteSchema, toLetter } from "./schemas.js";
import { deliverLetter } from "./deliver.js";
import type { House } from "./house.js";
import type { RetrievalQuery } from "./retrieval/retrieval.js";
import type { AuthService, Authenticated } from "./auth/service.js";
import { isVisibleTo, isPublicAddress, visibleToSql, filterVisible, PUB_ADDRESS } from "./auth/visibility.js";
import type { InviteService } from "./invites/service.js";
import type { BookService } from "./book/service.js";
import { BOOK_ADDRESS } from "./book/service.js";

import { createOidcRoutes } from "./routes/oidc.js";
import { createLettersRoutes } from "./routes/letters.js";
import { createPayloadsRoutes } from "./routes/payloads.js";
import { createAddressesRoutes } from "./routes/addresses.js";
import { createThreadsRoutes } from "./routes/threads.js";
import { createAgentsRoutes } from "./routes/agents.js";
import { createWhisperRoutes } from "./routes/whisper.js";
import { createHouseWordsRoutes } from "./routes/house_words.js";
import { createBookRoutes } from "./routes/book.js";

export const MAX_LIMIT = 100;
export const DEFAULT_LIMIT = 20;

export interface LetterServerOptions {
  /** The auth service. When omitted, the house runs unauthenticated (development only). */
  auth?: AuthService;
  /** The invite service — invitation-only membership. When omitted, redemption is unavailable. */
  invites?: InviteService;
  /** The house book — the commons made structural. When omitted, the book is unavailable. */
  book?: BookService;
}

/** The OIDC PKCE verifier + state, held in memory for the callback. */
export interface OidcPending {
  verifier: string;
  state: string;
  expiresAt: number;
}

export function createLetterServer(house: House, options: LetterServerOptions = {}) {
  const auth = options.auth;
  const invites = options.invites;
  const book = options.book;
  const app = new Hono();
  const oidcPending = new Map<string, OidcPending>();
  const OIDC_TTL_MS = 10 * 60 * 1000;

  // Security headers & body limit (sized to the standard 25 MB email payload + envelope overhead).
  app.use(
    "*",
    secureHeaders({
      xContentTypeOptions: "nosniff",
      xFrameOptions: "DENY",
      referrerPolicy: "strict-origin-when-cross-origin",
    }),
  );
  app.use(
    "*",
    bodyLimit({
      maxSize: 30 * 1024 * 1024,
      onError: (c) =>
        c.json(
          {
            error: {
              code: "payload_too_large",
              message: "the letter exceeds the house's 25 MB mail limit",
            },
          },
          413,
        ),
    }),
  );

  const oidcLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 20,
    message: "too many attempts at the door — wait a moment",
  });
  const redeemLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 10,
    message: "the house asks you to wait before trying another invitation code",
  });
  const pwLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 10,
    message: "the house asks you to wait a moment — too many attempts",
  });
  const whisperLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 120,
  });

  app.onError((err, c) => {
    house.log.error("server:error", { message: err.message });
    return c.json(
      { error: { code: "internal", message: "the house stumbled — try again" } },
      500,
    );
  });

  app.notFound((c) =>
    c.json({ error: { code: "not_found", message: "no such thing in the house" } }, 404),
  );

  // Health — the house is awake. Public: a health check must not need a key.
  app.get("/v1/health", (c) => c.json({ status: "awake" }));


  // Resolve the caller. Returns the authenticated address, or null when the
  // request is not authenticated. When auth is disabled (development), the
  // caller is the default owner.
  async function caller(c: { req: { header(name: string): string | undefined } }): Promise<Authenticated | null> {
    if (!auth) return { address: "you@house", method: "password" };
    return auth.authenticate(c.req.header("Authorization"));
  }

  app.route('/', createOidcRoutes(house, caller, auth, invites, book, { oidcLimiter, redeemLimiter, pwLimiter, whisperLimiter, oidcPending, OIDC_TTL_MS }));
  app.route('/', createLettersRoutes(house, caller, auth, invites, book, { oidcLimiter, redeemLimiter, pwLimiter, whisperLimiter, oidcPending, OIDC_TTL_MS }));
  app.route('/', createPayloadsRoutes(house, caller, auth, invites, book, { oidcLimiter, redeemLimiter, pwLimiter, whisperLimiter, oidcPending, OIDC_TTL_MS }));
  app.route('/', createAddressesRoutes(house, caller, auth, invites, book, { oidcLimiter, redeemLimiter, pwLimiter, whisperLimiter, oidcPending, OIDC_TTL_MS }));
  app.route('/', createThreadsRoutes(house, caller, auth, invites, book, { oidcLimiter, redeemLimiter, pwLimiter, whisperLimiter, oidcPending, OIDC_TTL_MS }));
  app.route('/', createAgentsRoutes(house, caller, auth, invites, book, { oidcLimiter, redeemLimiter, pwLimiter, whisperLimiter, oidcPending, OIDC_TTL_MS }));
  app.route('/', createWhisperRoutes(house, caller, auth, invites, book, { oidcLimiter, redeemLimiter, pwLimiter, whisperLimiter, oidcPending, OIDC_TTL_MS }));
  app.route('/', createHouseWordsRoutes(house, caller, auth, invites, book, { oidcLimiter, redeemLimiter, pwLimiter, whisperLimiter, oidcPending, OIDC_TTL_MS }));
  app.route('/', createBookRoutes(house, caller, auth, invites, book, { oidcLimiter, redeemLimiter, pwLimiter, whisperLimiter, oidcPending, OIDC_TTL_MS }));
  return app;
}
