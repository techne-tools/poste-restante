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
import { letterIdFromCanonical, canonicaliseWith, resolveSignedId } from "../id.js";
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
    private readonly payloads: PayloadStore | undefined,
    private readonly log: Logger,
    private readonly onLeaveJoin?: LeaveJoinHook,
    private readonly onStored?: OnStoredHook,
  ) {}

  /**
   * Ingest a letter. Idempotent: the same letter (same id) is stored once.
   * The id is derived from the envelope+body with addresses resolved to
   * their identity ids (SPEC §19) — a rename never changes a letter's id, and
   * neither does a key rotation (a sealed letter keeps the id its signature
   * was made over; see resolveId).
   */
  async ingest(letter: Letter): Promise<IngestResult> {
    // The id is derived from the envelope+body, and a sealed letter's
    // signature is verified on the way (SPEC §15) — one pass, because the id
    // a signature names is the id the SENDER hashed, which may belong to an
    // earlier generation of their key (see resolveId). A caller-supplied id is
    // ignored: the hash is the identity, so two identical letters are the same
    // letter and a changed letter is a new one.
    const { id, rejected } = await this.resolveId(letter);
    const existing = await this.repo.getLetter(id);
    if (existing) {
      this.log.info("ingest:duplicate", { letterId: id });
      return { letterId: id, created: false };
    }
    // A signature that verifies under no key the sender has ever held is NOT
    // a duplicate: it is a rejection. The house does not store what it cannot
    // verify, and the route answers 400, never 200.
    if (rejected) {
      this.log.warn("ingest:sealed-signature-invalid", { letterId: id });
      return { letterId: id, created: false, rejected: true };
    }

    const receivedAt = new Date(letter.time.gregorian);
    // Sealed letters (SPEC §15): the body is ciphertext the house stores
    // but never reads. No plain-text extraction, no embedding, no FTS —
    // the house cannot index what it cannot read, and it does not pretend
    // otherwise. The signature was verified in resolveId (above); the body
    // stays opaque.
    const sealed = letter.body.format === "sealed";
    const bodyText = sealed ? "" : markdownToText(letter.body.content);
    const stored: StoredLetter = { ...letter, id, receivedAt, bodyText };

    // 1. Postgres row + links (thread, correspondents, frames).
    await this.repo.storeLetter(stored);
    // Log the seal, never the pointer: a thread id in a log names a
    // relationship (AGENTS.md privacy checklist #6). The letter id is a
    // content hash; the sealed flag is the one fact an operator needs.
    this.log.info("ingest:stored", { letterId: id, sealed });

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

    // 6. A leave/join/shelve/unshelve letter updates the participation
    //    cache — the structural stop and the shelf are derived from the
    //    letters, not declared.
    if (
      this.onLeaveJoin &&
      (letter.envelope.kind === "leave" ||
        letter.envelope.kind === "join" ||
        letter.envelope.kind === "shelve" ||
        letter.envelope.kind === "unshelve")
    ) {
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
   * Resolve a letter's id — and, for a sealed letter, verify its signature on
   * the way (SPEC §15). The id hashes the envelope+body with every handle
   * resolved to its identity id, which is the ed25519 fingerprint of the key
   * the address holds NOW (SPEC §19); legacy addresses without keys resolve to
   * their handle.
   *
   * A sealed letter's signature is ed25519 over the id as of signing, and a
   * rotation changes the fingerprint the id resolves to. So verification walks
   * the sender's key history newest-first (`resolveSignedId`) and returns the
   * id the signature actually covers: a letter written before the sender
   * rotated re-delivers to its ORIGINAL id — verified against the retired key,
   * stored once, not rejected and not duplicated.
   *
   * `rejected` means no key the sender has ever held verifies the signature.
   * The returned id is then the current-resolution id (what the letter would
   * have been keyed as), which is what the logs and the 400 name.
   */
  private async resolveId(letter: Letter): Promise<{ id: string; rejected?: boolean }> {
    const identities = await this.identityIds(letter);
    const id = letterIdFromCanonical(canonicaliseWith(letter, identities));
    if (letter.body.format !== "sealed") return { id };

    const history = await this.repo.getAddressKeyHistory(letter.envelope.from);
    const signedId = resolveSignedId(
      letter,
      identities,
      history.map((record) => record.ed25519_public),
      letter.body.signature,
      verifyLetterId,
    );
    return signedId === null ? { id, rejected: true } : { id: signedId };
  }

  /**
   * The identity ids for every handle a letter names (SPEC §19). The resolver
   * reads address_keys — the LIVE row only (a retired key is not where a
   * correspondent seals, and not what a new letter's id resolves to).
   */
  private async identityIds(letter: Letter): Promise<Map<string, string>> {
    const handles = new Set<string>([
      letter.envelope.from,
      ...letter.envelope.to,
      ...letter.envelope.cc,
    ]);
    const identities = new Map<string, string>();
    for (const handle of handles) {
      const key = await this.repo.getAddressKey(handle);
      if (key) identities.set(handle, key.ed25519_public);
    }
    return identities;
  }

  /**
   * Delete a letter from all three tiers. No soft delete — the archive forgets.
   */
  async delete(letterId: string): Promise<boolean> {
    const removed = await this.repo.deleteLetter(letterId);
    if (removed) {
      await this.semantic.delete(letterId);
      try {
        await this.payloads?.deleteForLetter(letterId);
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
