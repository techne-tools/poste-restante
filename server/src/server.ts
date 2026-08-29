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
 */
import { Hono } from "hono";
import { z } from "zod";
import { LETTER_KINDS } from "./types.js";
import type { House } from "./house.js";
import type { StoredLetterRow } from "./db/repository.js";
import type { RetrievalQuery } from "./retrieval/retrieval.js";

const FrameSchema = z.object({
  frame: z.string().min(1),
  value: z.string().min(1),
});

const EnvelopeSchema = z.object({
  from: z.string().min(1),
  to: z.array(z.string().min(1)).min(1),
  cc: z.array(z.string().min(1)).default([]),
  thread: z.string().min(1),
  kind: z.enum(LETTER_KINDS),
  lang: z.string().min(1).default("en-AU"),
  subject: z.string().default(""),
});

const TimeSchema = z.object({
  gregorian: z.string().refine((s) => !Number.isNaN(Date.parse(s)), {
    message: "gregorian must be an ISO-8601 timestamp",
  }),
  frames: z.array(FrameSchema).default([]),
});

const BodySchema = z.object({
  format: z.literal("markdown"),
  content: z.string(),
});

const LetterSchema = z.object({
  // The id is derived from the envelope+body. A caller-supplied id is
  // accepted for contract compatibility but ignored — the hash is the identity.
  id: z.string().optional(),
  envelope: EnvelopeSchema,
  time: TimeSchema,
  body: BodySchema,
});

const AddressSchema = z.object({
  names: z.array(z.string()).default([]),
  pronouns: z.string().nullable().default(null),
});

const MAX_LIMIT = 100;
const DEFAULT_LIMIT = 20;

/** Map a stored row back to the contract letter shape. */
function toLetter(row: StoredLetterRow) {
  return {
    id: row.id,
    envelope: {
      from: row.from_addr,
      to: row.to_addrs,
      cc: row.cc_addrs,
      thread: row.thread_id,
      kind: row.kind,
      lang: row.lang,
      subject: row.subject,
    },
    time: {
      gregorian: row.received_at.toISOString(),
      frames: row.frames,
    },
    body: {
      format: "markdown" as const,
      content: row.body,
    },
    receivedAt: row.received_at.toISOString(),
    pinnedAt: row.pinned_at?.toISOString() ?? null,
    pinnedBy: row.pinned_by ?? null,
  };
}

export interface LetterServerOptions {
  /** The address that pins letters (the owner). Defaults to the human. */
  ownerAddress?: string;
}

export function createLetterServer(house: House, options: LetterServerOptions = {}) {
  const owner = options.ownerAddress ?? "you@house";
  const app = new Hono();

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

  // Health — the house is awake.
  app.get("/v1/health", (c) => c.json({ status: "awake" }));

  // ── Letters ──────────────────────────────────────────────────────────────

  // Deliver a letter. Idempotent: the same letter (same envelope+body) is
  // stored once; the response reports whether it was newly created.
  app.post("/v1/letters", async (c) => {
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
    // The id is derived from the envelope+body; a caller-supplied id is
    // ignored (the hash is the identity). Strip it before ingest.
    const { id: _ignored, ...letter } = parsed.data;
    const { letterId, created } = await house.pipeline.ingest(letter);
    // The house's own letters surface in the whisper — correspondence, not
    // metadata. Quiet when not relevant; the client comes for it.
    if (created && letter.envelope.kind === "system" && letter.envelope.from === "house@house") {
      const summary = letter.body.content.slice(0, 200);
      await house.whisper.surfaceHouseLetter(letterId, letter.envelope.thread, summary);
    }
    // Writing back is the strongest signal: a letter in a whispered thread
    // marks the whisper replied.
    if (created) {
      await house.whisper.recordReply(letter.envelope.thread);
    }
    return c.json({ id: letterId, created }, created ? 201 : 200);
  });

  // Retrieval — three paths (exact, full-text, semantic) merged by RRF.
  // Pull by default; the client asks. Ranking uses the house's own signals.
  app.get("/v1/letters", async (c) => {
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
    return c.json({
      hits: hits.map((h) => ({
        letterId: h.letterId,
        score: h.score,
        paths: h.paths,
        ranks: h.ranks,
      })),
      letters: letters.map(toLetter),
    });
  });

  // Fetch one letter.
  app.get("/v1/letters/:id", async (c) => {
    const row = await house.repo.getLetter(c.req.param("id"));
    if (!row) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }
    return c.json(toLetter(row));
  });

  // Delete a letter. First-class: gone from postgres, qdrant, and FTS.
  app.delete("/v1/letters/:id", async (c) => {
    const id = c.req.param("id");
    const removed = await house.pipeline.delete(id);
    if (!removed) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }
    return c.json({ deleted: true, id });
  });

  // Pin / unpin — explicit house ranking signals.
  app.post("/v1/letters/:id/pin", async (c) => {
    const id = c.req.param("id");
    const row = await house.repo.getLetter(id);
    if (!row) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }
    await house.repo.pinLetter(id, owner);
    return c.json({ pinned: true, id });
  });

  app.delete("/v1/letters/:id/pin", async (c) => {
    const id = c.req.param("id");
    const row = await house.repo.getLetter(id);
    if (!row) {
      return c.json({ error: { code: "not_found", message: "no such letter" } }, 404);
    }
    await house.repo.unpinLetter(id);
    return c.json({ pinned: false, id });
  });

  // ── Addresses ─────────────────────────────────────────────────────────────

  // The address book — the social graph. Flat, no ranking, no follower counts.
  app.get("/v1/addresses", async (c) => {
    const addresses = await house.repo.listAddresses();
    return c.json({ addresses });
  });

  app.get("/v1/addresses/:address", async (c) => {
    const address = await house.repo.getAddress(c.req.param("address"));
    if (!address) {
      return c.json({ error: { code: "not_found", message: "no such address" } }, 404);
    }
    return c.json(address);
  });

  // Correct the address book. The house takes corrections at face value.
  app.patch("/v1/addresses/:address", async (c) => {
    const address = c.req.param("address");
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
    const letters = await house.repo.listMailbox(address, limit);
    return c.json({ address, letters: letters.map(toLetter) });
  });

  // ── Threads & frames ──────────────────────────────────────────────────────

  // Threads are correspondences. The thread is the unit, not the message.
  app.get("/v1/threads/:id", async (c) => {
    const threadId = c.req.param("id");
    const letters = await house.repo.listThread(threadId);
    if (letters.length === 0) {
      return c.json({ error: { code: "not_found", message: "no such thread" } }, 404);
    }
    return c.json({ thread: threadId, letters: letters.map(toLetter) });
  });

  // Frames — plural time navigation. Queries work in any frame.
  app.get("/v1/frames", async (c) => {
    const frames = await house.repo.listFrames();
    return c.json({ frames });
  });

  // ── The whisper ────────────────────────────────────────────────────────────

  // The whisper — the mailbox for the house's own letters. A GET resource.
  // Nothing pushes; the client comes for it. `?unread=1` shows only what the
  // house is offering right now.
  app.get("/v1/whisper", async (c) => {
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
      ? await house.whisper.listUnread(limit)
      : await house.whisper.list(limit);
    return c.json({ whispers });
  });

  // The user opened a whisper. A signal, not a notification.
  app.post("/v1/whisper/:id/open", async (c) => {
    const ok = await house.whisper.open(c.req.param("id"));
    if (!ok) {
      return c.json({ error: { code: "not_found", message: "no such whisper" } }, 404);
    }
    return c.json({ opened: true, id: c.req.param("id") });
  });

  // Explicit dismissal — the strongest negative signal. The house takes
  // corrections at face value; undismiss is always possible.
  app.post("/v1/whisper/:id/dismiss", async (c) => {
    const ok = await house.whisper.dismiss(c.req.param("id"));
    if (!ok) {
      return c.json({ error: { code: "not_found", message: "no such whisper" } }, 404);
    }
    return c.json({ dismissed: true, id: c.req.param("id") });
  });

  app.post("/v1/whisper/:id/undismiss", async (c) => {
    const ok = await house.whisper.undismiss(c.req.param("id"));
    if (!ok) {
      return c.json({ error: { code: "not_found", message: "no such whisper" } }, 404);
    }
    return c.json({ dismissed: false, id: c.req.param("id") });
  });

  // Gap detection — cheap structural checks (dormant threads, unanswered
  // questions). Runs on demand; the house never pushes the results.
  app.post("/v1/whisper/gaps", async (c) => {
    const created = await house.whisper.detectGaps();
    return c.json({ created: created.map((w) => w.id) });
  });

  return app;
}
