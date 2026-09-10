/**
 * Ingestion pipeline. The spine of the house.
 *
 *   letter arrives
 *     → postgres row (envelope fields, thread, frames)
 *     → body extracted, markdown parsed
 *     → embedded → qdrant vector
 *     → indexed for full-text (postgres FTS)
 *     → linked to thread, correspondents, frames
 *
 * Observable via structured logs (no telemetry — logs stay local).
 */
import type { Logger } from "./logger.js";
import type { Letter, StoredLetter } from "../types.js";
import { letterId } from "../id.js";
import { markdownToText } from "./markdown.js";
import { verifyLetterId } from "../crypto/keys.js";
import type { PostgresRepository } from "../db/repository.js";
import type { SemanticStore } from "../qdrant/store.js";
import type { Embedder } from "../embed/embedder.js";
import type { PayloadStore } from "../minio/store.js";

export interface IngestResult {
  letterId: string;
  /** True if the letter was newly stored; false if it already existed. */
  created: boolean;
  /** True when a sealed letter's signature failed verification — the
   *  house does not store what it cannot verify, and this is NOT a
   *  duplicate: it is a rejection. The route answers 400, never 200. */
  rejected?: boolean;
}

/** A hook fired after a leave/join letter is stored — the participation
 *  cache is derived from the letters, and the pipeline is the single write
 *  path. Wired by the house to avoid a circular dependency (the
 *  ParticipationService uses the pipeline to write its own letters). */
export type LeaveJoinHook = (letter: Letter) => Promise<unknown>;

/** A hook fired after ANY letter is stored (SPEC §5 #13) — the outbound
 *  relay and (later) the mailbox materialisation ride the single write
 *  path, so every ingest face (HTTP, MCP, the SMTP door) behaves
 *  identically. A hook failure never loses the letter — the archive row is
 *  already stored; the failure is logged, and the derived view syncs on
 *  the next pass. */
export type OnStoredHook = (letter: StoredLetter) => Promise<unknown>;

export class IngestionPipeline {
  constructor(
    private readonly repo: PostgresRepository,
    private readonly semantic: SemanticStore,
    private readonly embedder: Embedder,
    private readonly payloads: PayloadStore,
    private readonly log: Logger,
    private readonly onLeaveJoin?: LeaveJoinHook,
    private readonly onStored?: OnStoredHook,
  ) {}

  /**
   * Ingest a letter. Idempotent: the same letter (same id) is stored once.
   * Returns `created: false` if the letter already exists.
   */
  async ingest(letter: Letter): Promise<IngestResult> {
    // The id is always derived from the envelope+body. A caller-supplied id is
    // ignored — the hash is the identity, so two identical letters are the same
    // letter and a changed letter is a new one.
    const id = letterId(letter);
    const existing = await this.repo.getLetter(id);
    if (existing) {
      this.log.info("ingest:duplicate", { letterId: id });
      return { letterId: id, created: false };
    }

    const receivedAt = new Date(letter.time.gregorian);
    // Sealed letters (SPEC §15): the body is ciphertext the house stores
    // but never reads. No plain-text extraction, no embedding, no FTS —
    // the house cannot index what it cannot read, and it does not pretend
    // otherwise. The signature is verified on ingest (below); the body
    // stays opaque.
    const sealed = letter.body.format === "sealed";
    const bodyText = sealed ? "" : markdownToText(letter.body.content);
    const stored: StoredLetter = { ...letter, id, receivedAt, bodyText };

    // 0. Verify the signature on ingest (SPEC §15). The signature is
    //    ed25519 over the letter id — the stored form. A bad signature is
    //    rejected before anything is written: the house does not store
    //    what it cannot verify. (The sender's public key is looked up by
    //    the caller — the route — because the pipeline has no auth.)
    if (sealed && letter.body.format === "sealed") {
      const ok = await this.verifySealed(letter, id);
      if (!ok) {
        this.log.warn("ingest:sealed-signature-invalid", { letterId: id });
        return { letterId: id, created: false, rejected: true };
      }
    }

    // 1. Postgres row + links (thread, correspondents, frames).
    await this.repo.storeLetter(stored);
    this.log.info("ingest:stored", { letterId: id, thread: letter.envelope.thread, sealed });

    // 2. Embed the plain-text body and index in Qdrant — only for
    //    unsealed letters. Sealed bodies never reach the semantic layer
    //    (SPEC §15: "sealed = not indexed, not whispered, not
    //    semantically connected").
    if (!sealed) {
      try {
        const vector = await this.embedder.embed(bodyText);
        this.log.info("ingest:embedded", { letterId: id, dimension: vector.length });

        // 3. Qdrant vector.
        await this.semantic.upsert(id, vector);
        this.log.info("ingest:indexed-semantic", { letterId: id });
      } catch (err) {
        this.log.error("ingest:semantic-index-failed", {
          letterId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    } else {
      this.log.info("ingest:sealed-not-indexed", { letterId: id });
    }

    // 4. Full-text: the postgres FTS index is maintained by the row insert
    //    (the GIN index on body_text). Nothing further to do here.

    // 5. Raw payloads: the letter's enclosures live in the payload store
    //    (MinIO when configured; the noop fallback otherwise). The payload
    //    API (server.ts /v1/letters/:id/payloads) writes them directly.

    // 6. A leave/join letter updates the participation cache — the
    //    structural stop is derived from the letters, not declared.
    if (this.onLeaveJoin && (letter.envelope.kind === "leave" || letter.envelope.kind === "join")) {
      await this.onLeaveJoin(stored);
    }

    // 7. Derived views ride the single write path (outbound relay, and
    //    later the mailbox materialisation). A failure here is logged, never
    //    fatal — the letter is already stored; the view re-syncs next pass.
    if (this.onStored) {
      try {
        await this.onStored(stored);
      } catch (err) {
        this.log.error("ingest:on-stored-failed", {
          letterId: id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return { letterId: id, created: true };
  }

  /**
   * Verify a sealed letter's signature (SPEC §15). The signature is
   * ed25519 over the letter id — the stored form. The sender's public key
   * comes from the address_keys table (public keys are public). A missing
   * key record or a bad signature fails verification: the house does not
   * store what it cannot verify.
   */
  private async verifySealed(letter: Letter, id: string): Promise<boolean> {
    if (letter.body.format !== "sealed") return false;
    const key = await this.repo.getAddressKey(letter.envelope.from);
    if (!key) return false;
    return verifyLetterId(id, letter.body.signature, key.ed25519_public);
  }

  /**
   * Delete a letter from all three tiers. No soft delete — the archive forgets.
   */
  async delete(letterId: string): Promise<boolean> {
    const removed = await this.repo.deleteLetter(letterId);
    if (removed) {
      await this.semantic.delete(letterId);
      try {
        await this.payloads.deleteForLetter(letterId);
      } catch (err) {
        this.log.error("ingest:payload-delete-failed", {
          letterId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      this.log.info("ingest:deleted", { letterId });
    }
    return removed;
  }
}
