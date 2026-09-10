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
import { AddressSchema, LetterSchema, RedeemSchema, ClauseActionSchema, toLetter } from "./schemas.js";
import { deliverLetter } from "./deliver.js";
import type { House } from "./house.js";
import type { RetrievalQuery } from "./retrieval/retrieval.js";
import type { AuthService, Authenticated } from "./auth/service.js";
import { isVisibleTo, isPublicAddress, visibleToSql, filterVisible, PUB_ADDRESS } from "./auth/visibility.js";
import type { InviteService } from "./invites/service.js";
import type { BookService } from "./book/service.js";
import { BOOK_ADDRESS } from "./book/service.js";

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

export interface LetterServerOptions {
  /** The auth service. When omitted, the house runs unauthenticated (development only). */
  auth?: AuthService;
  /** The invite service — invitation-only membership. When omitted, redemption is unavailable. */
  invites?: InviteService;
  /** The house book — the commons made structural. When omitted, the book is unavailable. */
  book?: BookService;
}

/** The OIDC PKCE verifier + state, held in memory for the callback. */
interface OidcPending {
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
    message: "too many sign-in attempts — please wait a moment",
  });
  const redeemLimiter = createRateLimiter({
    windowMs: 60_000,
    max: 10,
    message: "the house asks you to wait before trying another invitation code",
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

  // ── Authentication ────────────────────────────────────────────────────────

  // Resolve the caller. Returns the authenticated address, or null when the
  // request is not authenticated. When auth is disabled (development), the
  // caller is the default owner.
  async function caller(c: { req: { header(name: string): string | undefined } }): Promise<Authenticated | null> {
    if (!auth) return { address: "you@house", method: "password" };
    return auth.authenticate(c.req.header("Authorization"));
  }

  // ── OIDC routes ────────────────────────────────────────────────────────────

  // Start the OIDC dance. Returns the provider URL; the client redirects.
  app.get("/v1/auth/oidc/start", oidcLimiter, async (c) => {
    if (!auth || !auth.oidcEnabled) {
      return c.json({ error: { code: "oidc_disabled", message: "OIDC is not configured" } }, 400);
    }
    const { url, verifier, state } = await auth.oidcStart();
    oidcPending.set(state, { verifier, state, expiresAt: Date.now() + OIDC_TTL_MS });
    return c.json({ url, state });
  });

  // The provider redirects here with ?code=&state=. Exchange, verify, resolve.
  app.get("/v1/auth/oidc/callback", async (c) => {
    const code = c.req.query("code");
    const state = c.req.query("state");
    if (!code || !state) {
      return c.json({ error: { code: "oidc_missing", message: "the provider did not return a code" } }, 400);
    }
    const pending = oidcPending.get(state);
    if (!pending || pending.expiresAt < Date.now()) {
      return c.json({ error: { code: "oidc_expired", message: "this sign-in attempt has expired — start again" } }, 400);
    }
    oidcPending.delete(state);
    if (!auth) {
      return c.json({ error: { code: "oidc_disabled", message: "OIDC is not configured" } }, 400);
    }
    try {
      const { address } = await auth.oidcCallback(code, pending.verifier);
      return c.json({ address });
    } catch (err) {
      house.log.warn("oidc:callback-failed", { message: err instanceof Error ? err.message : String(err) });
      return c.json({ error: { code: "oidc_failed", message: "the house could not verify this identity" } }, 401);
    }
  });

  // Redeem an invite — the guest's door into the house. Public, like the
  // health check: the whole point is that a guest has no credential yet.
  // Proves possession of the invite letter (address is a participant) and
  // the one-time code; the house issues the credential the guest sets
  // themselves. Fail closed: every negative path answers 404, never 403,
  // and never confirms that an invite exists. Absence is silence.
  app.post("/v1/invites/redeem", redeemLimiter, async (c) => {
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

  // ── Letters ──────────────────────────────────────────────────────────────

  // Deliver a letter. Idempotent: the same letter (same envelope+body) is
  // stored once; the response reports whether it was newly created. The
  // sender must be the caller — no forging.
  app.post("/v1/letters", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        { error: { code: "invalid_json", message: "the letter must be JSON" } },
        400,
      );
    }
    const parsed = LetterSchema.safeParse(body);
    if (!parsed.success) {
      return c.json(
        {
          error: {
            code: "invalid_letter",
            message: "the letter does not match the contract",
            details: parsed.error.flatten(),
          },
        },
        400,
      );
    }
    // No forging: the envelope's from must be the caller's own address.
    // (Only enforced when authentication is on — dev mode trusts the caller.)
    if (auth && parsed.data.envelope.from !== who.address) {
      return c.json(
        { error: { code: "forged", message: "a letter's from must be your own address" } },
        403,
      );
    }
    // The id is derived from the envelope+body; a caller-supplied id is
    // ignored (the hash is the identity). Deliver — ingest, surface house
    // letters in the whisper, mark whispered threads replied.
    const { letterId, created, rejected } = await deliverLetter(house, parsed.data);
    if (rejected) {
      return c.json(
        { error: { code: "invalid_signature", message: "the letter's signature does not verify" } },
        400,
      );
    }
    return c.json({ id: letterId, created }, created ? 201 : 200);
  });

  // Retrieval — three paths (exact, full-text, semantic) merged by RRF.
  // Pull by default; the client asks. Ranking uses the house's own signals.
  // Private by default: results are scoped to the caller's participation.
  app.get("/v1/letters", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);

    const query: RetrievalQuery = {};

    const text = c.req.query("text");
    if (text) query.text = text;
    const from = c.req.query("from");
    if (from) query.from = from;
    const to = c.req.query("to");
    if (to) query.to = to;
    const thread = c.req.query("thread");
    if (thread) query.thread = thread;
    const kind = c.req.query("kind");
    if (kind) {
      if (!(LETTER_KINDS as readonly string[]).includes(kind)) {
        return c.json(
          {
            error: {
              code: "invalid_kind",
              message: `kind must be one of: ${LETTER_KINDS.join(", ")}`,
            },
          },
          400,
        );
      }
      query.kind = kind as RetrievalQuery["kind"];
    }
    const frame = c.req.query("frame");
    if (frame) query.frame = frame;
    const pinned = c.req.query("pinned");
    if (pinned === "true" || pinned === "1") query.pinned = true;

    const limitRaw = c.req.query("limit");
    let limit = DEFAULT_LIMIT;
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
    query.limit = limit;

    const hits = await house.retrieval.search(query);
    const letters = await house.repo.getLetters(hits.map((h) => h.letterId));
    // Private by default: only letters the caller is party to (or public),
    // and only threads the caller is currently 'in' — a leaver's edges
    // dissolve (leaving as first-class).
    const participation = await house.repo.participationStates(
      letters.map((l) => l.thread_id),
      who.address,
    );
    const visible = filterVisible(letters, who.address, participation);
    const visibleIds = new Set(visible.map((l) => l.id));
    return c.json({
      hits: hits.filter((h) => visibleIds.has(h.letterId)).map((h) => ({
        letterId: h.letterId,
        score: h.score,
        paths: h.paths,
        ranks: h.ranks,
      })),
      letters: visible.map(toLetter),
    });
  });

  // Fetch one letter. Absence is silence: a letter the caller cannot see is
  // 404, never 403.
  app.get("/v1/letters/:id", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const row = await house.repo.getLetter(c.req.param("id"));
    if (!row) return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    const state = await house.repo.participationStates([row.thread_id], who.address);
    if (!isVisibleTo(row, who.address, state.get(row.thread_id) ?? "in")) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }
    return c.json(toLetter(row));
  });

  // Delete a letter. First-class: gone from postgres, qdrant, and FTS.
  // Only participants may delete (sender or recipient — the CONTRACT).
  app.delete("/v1/letters/:id", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const id = c.req.param("id");
    const row = await house.repo.getLetter(id);
    if (!row) return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    const state = await house.repo.participationStates([row.thread_id], who.address);
    if (!isVisibleTo(row, who.address, state.get(row.thread_id) ?? "in")) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }
    const removed = await house.pipeline.delete(id);
    if (!removed) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }
    return c.json({ deleted: true, id });
  });

  // Pin / unpin — explicit house ranking signals. Only participants may pin.
  app.post("/v1/letters/:id/pin", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const id = c.req.param("id");
    const row = await house.repo.getLetter(id);
    if (!row) return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    const state = await house.repo.participationStates([row.thread_id], who.address);
    if (!isVisibleTo(row, who.address, state.get(row.thread_id) ?? "in")) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }
    await house.repo.pinLetter(id, who.address);
    return c.json({ pinned: true, id });
  });

  app.delete("/v1/letters/:id/pin", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const id = c.req.param("id");
    const row = await house.repo.getLetter(id);
    if (!row) return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    const state = await house.repo.participationStates([row.thread_id], who.address);
    if (!isVisibleTo(row, who.address, state.get(row.thread_id) ?? "in")) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }
    await house.repo.unpinLetter(id);
    return c.json({ pinned: false, id });
  });

  // ── Letter Payloads (MinIO / S3 tier) ────────────────────────────────────

  // List payloads attached to a letter. Only visible participants may list.
  // The catalog (migration 016) makes each payload's shape a schema
  // property — name, content type, size — so the client can render an
  // enclosure without fetching bytes first.
  app.get("/v1/letters/:id/payloads", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const id = c.req.param("id");
    const row = await house.repo.getLetter(id);
    if (!row) return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    const state = await house.repo.participationStates([row.thread_id], who.address);
    if (!isVisibleTo(row, who.address, state.get(row.thread_id) ?? "in")) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }
    const catalog = await house.repo.listPayloads(id);
    const payloads = catalog.map((p) => ({
      key: `letters/${id}/${p.name}`,
      name: p.name,
      contentType: p.content_type,
      size: p.size,
    }));
    return c.json({ letterId: id, payloads });
  });

  // Upload a raw payload for a letter (audio memo, rehearsal recording, attachment).
  // Only participants may attach payloads. If the letter is kind: "audio",
  // triggers transcription if whisper is available.
  app.post("/v1/letters/:id/payloads", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const id = c.req.param("id");
    const row = await house.repo.getLetter(id);
    if (!row) return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    const state = await house.repo.participationStates([row.thread_id], who.address);
    if (!isVisibleTo(row, who.address, state.get(row.thread_id) ?? "in")) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }

    let name = c.req.header("X-Payload-Name") || c.req.query("name");
    let data: Uint8Array;
    let contentType = c.req.header("Content-Type") || "application/octet-stream";

    const contentTypeHeader = c.req.header("Content-Type") ?? "";
    if (contentTypeHeader.includes("multipart/form-data")) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || typeof file === "string") {
        return c.json({ error: { code: "invalid_payload", message: "expected multipart file field 'file'" } }, 400);
      }
      name = name || (file as File).name || "payload.bin";
      contentType = (file as File).type || contentType;
      data = new Uint8Array(await (file as File).arrayBuffer());
    } else {
      name = name || "payload.bin";
      data = new Uint8Array(await c.req.arrayBuffer());
    }

    if (data.length === 0) {
      return c.json({ error: { code: "empty_payload", message: "payload data is empty" } }, 400);
    }

    const key = await house.payloads.put(id, name, data, contentType);

    // Record the pointer in the catalog (migration 016). If the recording
    // fails, the freshly-stored object is orphaned bytes in MinIO — roll
    // it back so a failed upload leaves no trace.
    await house.repo.insertPayload(id, name, contentType, data.length).catch(async (err: unknown) => {
      await house.payloads.delete(key).catch(() => {});
      throw err;
    });

    // If kind === "audio" and whisper is enabled, trigger transcription
    if (row.kind === "audio" && house.config.whisperUrl) {
      void house.audio.transcribeAudioLetter(toLetter(row), key).catch((err) => {
        house.log.error("audio:payload-transcribe-failed", {
          letterId: id,
          key,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return c.json({ letterId: id, key, name, size: data.length }, 201);
  });

  // Fetch a raw payload by name.
  app.get("/v1/letters/:id/payloads/:name", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const id = c.req.param("id");
    const name = c.req.param("name");
    const row = await house.repo.getLetter(id);
    if (!row) return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    const state = await house.repo.participationStates([row.thread_id], who.address);
    if (!isVisibleTo(row, who.address, state.get(row.thread_id) ?? "in")) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }

    const key = `letters/${id}/${name}`;
    const data = await house.payloads.get(key);
    if (!data) {
      return c.json({ error: { code: "not_found", message: "payload not found" } }, 404);
    }

    // The catalog's content type — what the payload *is*, held as a schema
    // property (migration 016). It lets an image render inline, an audio
    // clip play in place, and a plain file download with its own MIME.
    const meta = await house.repo.getPayload(id, name);
    const contentType = meta?.content_type ?? "application/octet-stream";

    return new Response(Buffer.from(data), {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Disposition": `inline; filename="${name}"`,
      },
    });
  });

  // Delete a raw payload by name.
  app.delete("/v1/letters/:id/payloads/:name", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const id = c.req.param("id");
    const name = c.req.param("name");
    const row = await house.repo.getLetter(id);
    if (!row) return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    const state = await house.repo.participationStates([row.thread_id], who.address);
    if (!isVisibleTo(row, who.address, state.get(row.thread_id) ?? "in")) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }

    const key = `letters/${id}/${name}`;
    await house.payloads.delete(key);
    // The catalog dies with the bytes — no orphaned pointer.
    await house.repo.deletePayload(id, name);
    return c.json({ deleted: true, key });
  });

  // ── Addresses ─────────────────────────────────────────────────────────────

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
    await house.repo.updateAddress(address, parsed.data.names, parsed.data.pronouns);
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

  // ── Threads & frames ──────────────────────────────────────────────────────

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
        { error: { code: "invalid_join", message: "the book is commons by right — you cannot leave it" } },
        400,
      );
    }
    const { letterId, state: newState } = await house.participation.act(who.address, threadId, "join");
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

  // Frames — plural time navigation. Queries work in any frame.
  app.get("/v1/frames", async (c) => {
    const who = await caller(c);
    if (!who) return c.json({ error: { code: "unauthorized", message: "the house does not know you" } }, 401);
    const frames = await house.repo.listFrames();
    return c.json({ frames });
  });

  // ── The whisper ────────────────────────────────────────────────────────────

  // The whisper — the mailbox for the house's own letters. A GET resource.
  // Nothing pushes; the client comes for it. `?unread=1` shows only what the
  // house is offering right now. Scoped to the caller: the house only
  // whispers about correspondence the caller is party to.
  app.get("/v1/whisper", whisperLimiter, async (c) => {
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

  // ── The house book ────────────────────────────────────────────────────────

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
