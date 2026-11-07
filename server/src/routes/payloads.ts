import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { createRateLimiter } from "../auth/rate-limiter.js";
import { LETTER_KINDS } from "../types.js";
import { AddressSchema, LetterSchema, RedeemSchema, ChangePasswordSchema, RegisterKeysSchema, ClauseActionSchema, DayCardSchema, InviteSchema, toLetter } from "../schemas.js";
import { deliverLetter } from "../deliver.js";
import type { House } from "../house.js";
import type { StoredPayload } from "../minio/store.js";
import type { RetrievalQuery } from "../retrieval/retrieval.js";
import type { AuthService, Authenticated } from "../auth/service.js";
import { isVisibleTo, isPublicAddress, visibleToSql, filterVisible, PUB_ADDRESS } from "../auth/visibility.js";
import type { InviteService } from "../invites/service.js";
import type { BookService } from "../book/service.js";
import { BOOK_ADDRESS } from "../book/service.js";
import type { OidcPending } from "../server.js";
import { MAX_LIMIT, DEFAULT_LIMIT } from "../server.js";

/** The marker a client sets when the bytes it is sending are already age
 *  ciphertext sealed to the letter's participants. */
const SEALED_HEADER = "X-Payload-Sealed";

/** What a sealed enclosure's stored content type says. The real type rides
 *  inside the ciphertext — a content type is content ("a recording of the
 *  read-through"), so it must not reach the catalog. */
const SEALED_CONTENT_TYPE = "application/octet-stream";

/** The cap when the house has not set `PAYLOAD_MAX_BYTES`. Large because
 *  the upload path streams (E1): the ceiling is the disk, not the heap. */
const DEFAULT_PAYLOAD_MAX_BYTES = 512 * 1024 * 1024;

/** Raised by the limiter when a body outgrows the payload cap. */
class PayloadTooLargeError extends Error {}

/**
 * Bound a request body while it streams. The house no longer buffers the
 * whole upload (server.ts skips `bodyLimit` for this route), so the cap is
 * enforced HERE, chunk by chunk, and the rest of the pipeline never sees
 * more than one chunk in memory.
 */
function limitPayload(
  body: ReadableStream<Uint8Array>,
  maxBytes: number,
): ReadableStream<Uint8Array> {
  const reader = body.getReader();
  let seen = 0;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) {
        controller.close();
        return;
      }
      seen += value.byteLength;
      if (seen > maxBytes) {
        await reader.cancel().catch(() => {});
        controller.error(
          new PayloadTooLargeError(`the enclosure exceeds the house's ${maxBytes} byte limit`),
        );
        return;
      }
      controller.enqueue(value);
    },
    cancel(reason) {
      void reader.cancel(reason).catch(() => {});
    },
  });
}

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
  // enclosure without fetching bytes first. Migration 031 adds `sealed`:
  // the catalog can say the bytes are ciphertext, but nothing else about
  // them. A sealed payload's name and size stay visible; that metadata is
  // a pointer, not content.
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
      sealed: p.sealed,
    }));
    return c.json({ letterId: id, payloads });
  });

  // Upload a raw payload for a letter (audio memo, rehearsal recording, attachment).
  // Only participants may attach payloads.
  //
  // The seal (SPEC §15, PLAN-crypto.md C1): a sealed letter's enclosure is
  // sealed by its writer BEFORE it reaches the house, exactly like the body.
  // The marker and the letter's `sealed` column must AGREE. Both directions
  // are refused, because either one leaks: plaintext on a sealed letter
  // would let the house read what it sealed; ciphertext on an unsealed
  // letter would be an enclosure the recipient cannot open without keys
  // they may not have.
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

    const isSealed = c.req.header(SEALED_HEADER) === "1";
    if (Boolean(row.sealed) !== isSealed) {
      return c.json(
        {
          error: {
            code: "payload_seal_mismatch",
            message: row.sealed
              ? "this letter is sealed — its enclosures must arrive sealed too"
              : "this letter is not sealed — a sealed enclosure cannot be attached to it",
          },
        },
        422,
      );
    }

    let name = c.req.header("X-Payload-Name") || c.req.query("name");
    let contentType = c.req.header("Content-Type") || "application/octet-stream";

    const contentTypeHeader = c.req.header("Content-Type") ?? "";
    const isMultipart = contentTypeHeader.includes("multipart/form-data");

    // The stored type. A sealed enclosure is octet-stream by definition:
    // the client's claimed type is content, and the real one travels
    // inside the ciphertext where only participants can read it.
    const storedType = isSealed ? SEALED_CONTENT_TYPE : contentType;

    let stored: StoredPayload | undefined;

    if (isMultipart && isSealed) {
      // A multipart envelope is plaintext metadata (filename, type) wrapped
      // around the ciphertext. Sealed uploads travel as a bare body.
      return c.json(
        {
          error: {
            code: "sealed_payload_requires_raw_body",
            message: "a sealed enclosure is uploaded as a raw body, not multipart/form-data",
          },
        },
        422,
      );
    }

    if (isMultipart) {
      const body = await c.req.parseBody();
      const file = body["file"];
      if (!file || typeof file === "string") {
        return c.json({ error: { code: "invalid_payload", message: "expected multipart file field 'file'" } }, 400);
      }
      name = name || (file as File).name || "payload.bin";
      contentType = (file as File).type || contentType;
      const data = new Uint8Array(await (file as File).arrayBuffer());
      if (data.length === 0) {
        return c.json({ error: { code: "empty_payload", message: "payload data is empty" } }, 400);
      }
      const key = await house.payloads?.put(id, name, data, storedType);
      if (!key) {
        return c.json(
          { error: { code: "payload_store_unavailable", message: "the house has nowhere to keep this enclosure" } },
          503,
        );
      }
      stored = { key, size: data.length };
    } else {
      name = name || "payload.bin";
      const raw = c.req.raw.body;
      if (!raw) {
        return c.json({ error: { code: "empty_payload", message: "payload data is empty" } }, 400);
      }

      const maxBytes = house.config.payloadMaxBytes ?? DEFAULT_PAYLOAD_MAX_BYTES;
      const declared = Number.parseInt(c.req.header("content-length") ?? "", 10);
      const hasDeclared = Number.isFinite(declared) && declared >= 0;
      if (hasDeclared && declared > maxBytes) {
        return c.json(
          {
            error: {
              code: "payload_too_large",
              message: `the enclosure exceeds the house's ${maxBytes} byte limit`,
            },
          },
          413,
        );
      }

      // Seal → stream → store. Nothing here reads the bytes in full, and
      // nothing here can decrypt them: the route moves opaque data.
      try {
        stored = await house.payloads?.putStream(
          id,
          name,
          limitPayload(raw, maxBytes),
          storedType,
          hasDeclared ? declared : undefined,
        );
      } catch (err) {
        if (err instanceof PayloadTooLargeError) {
          return c.json(
            {
              error: {
                code: "payload_too_large",
                message: `the enclosure exceeds the house's ${maxBytes} byte limit`,
              },
            },
            413,
          );
        }
        throw err;
      }
      if (!stored) {
        return c.json(
          { error: { code: "payload_store_unavailable", message: "the house has nowhere to keep this enclosure" } },
          503,
        );
      }
      if (stored.size === 0) {
        await house.payloads?.delete(stored.key).catch(() => {});
        return c.json({ error: { code: "empty_payload", message: "payload data is empty" } }, 400);
      }
    }

    // Every path above either produced a stored object or returned an
    // error; this guard makes that a fact the type system can see.
    if (!stored) {
      return c.json(
        { error: { code: "payload_store_unavailable", message: "the house has nowhere to keep this enclosure" } },
        503,
      );
    }

    // Record the pointer in the catalog (migration 016, seal in 031). If
    // the recording fails, the freshly-stored object is orphaned bytes in
    // MinIO — roll it back so a failed upload leaves no trace.
    await house.repo.insertPayload(id, name, storedType, stored.size, isSealed).catch(async (err: unknown) => {
      if (stored) await house.payloads?.delete(stored.key).catch(() => {});
      throw err;
    });

    // If kind === "audio" and whisper is enabled, trigger transcription.
    // A sealed body is never transcribed: the house cannot read what it
    // sealed for a resident — a raw audio letter carries markdown/plain
    // text, a sealed one carries ciphertext the house does not open
    // (SPEC §15: the semantic layer and its helpers only see unsealed).
    // The seal mismatch above means `row.sealed` and `isSealed` agree, so
    // this also covers a sealed enclosure.
    if (row.kind === "audio" && house.config.whisperUrl && !row.sealed) {
      void house.audio.transcribeAudioLetter(toLetter(row), stored.key).catch((err) => {
        house.log.error("audio:payload-transcribe-failed", {
          letterId: id,
          key: stored!.key,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    }

    return c.json({ letterId: id, key: stored.key, name, size: stored.size, sealed: isSealed }, 201);
  });

  // Fetch a raw payload by name. A sealed payload is served as ciphertext,
  // byte for byte, with the marker so the client knows to unseal in memory.
  // There is no server-side decryption path here and there must never be.
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
    // clip play in place, and a plain file download with its own MIME. For
    // a sealed payload the row says octet-stream, and the response says so
    // too: the type is inside the ciphertext, not in the envelope.
    const meta = await house.repo.getPayload(id, name);
    const sealed = Boolean(meta?.sealed);
    const contentType = sealed
      ? SEALED_CONTENT_TYPE
      : (meta?.content_type ?? "application/octet-stream");

    const headers: Record<string, string> = {
      "Content-Type": contentType,
      "Content-Disposition": `inline; filename="${name}"`,
    };
    if (sealed) headers[SEALED_HEADER] = "1";

    return new Response(Buffer.from(data), { status: 200, headers });
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
