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

export function createPayloadsRoutes(
  house: House,
  caller: (c: any) => Promise<Authenticated | null>,
  auth: AuthService | undefined,
  invites: InviteService | undefined,
  book: BookService | undefined,
  limiters: any
) {
  const app = new Hono();

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

    const key = await house.payloads?.put(id, name, data, contentType);

    // Record the pointer in the catalog (migration 016). If the recording
    // fails, the freshly-stored object is orphaned bytes in MinIO — roll
    // it back so a failed upload leaves no trace.
    await house.repo.insertPayload(id, name, contentType ?? "application/octet-stream", data.length).catch(async (err: unknown) => {
      if (key) await house.payloads?.delete(key).catch(() => {});
      throw err;
    });

    // If kind === "audio" and whisper is enabled, trigger transcription.
    // A sealed body is never transcribed: the house cannot read what it
    // sealed for a resident — a raw audio letter carries markdown/plain
    // text, a sealed one carries ciphertext the house does not open
    // (SPEC §15: the semantic layer and its helpers only see unsealed).
    if (row.kind === "audio" && house.config.whisperUrl && !row.sealed) {
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
    const data = await house.payloads?.get(key);
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
    if (key) await house.payloads?.delete(key);
    // The catalog dies with the bytes — no orphaned pointer.
    await house.repo.deletePayload(id, name);
    return c.json({ deleted: true, key });
  });

  return app;
}
