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

export function createLettersRoutes(
  house: House,
  caller: (c: any) => Promise<Authenticated | null>,
  auth: AuthService | undefined,
  invites: InviteService | undefined,
  book: BookService | undefined,
  limiters: any
) {
  const app = new Hono();

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
    // The reach is enumerated, not discoverable (SPEC §16): an agent may
    // address exactly its three doors — creator, opt-in group, pub. The
    // server enforces who the agent may address on every write. The house
    // enforces reach, never content.
    if (auth && (await house.agents.isAgent(who.address))) {
      const doors = await house.agents.doors(who.address);
      const allowed =
        doors !== null &&
        parsed.data.envelope.to.every((r) => house.agents.canAddress(who.address, r));
      if (!allowed) {
        return c.json(
          { error: { code: "out_of_reach", message: "this instrument cannot address that door" } },
          403,
        );
      }
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
  // The archive is a law, and a law that may be asked to forget — the
  // house's archon is the resident, standing at the door (Foucault:
  // the archive governs what can be said; it does not own what was).
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

  return app;
}
