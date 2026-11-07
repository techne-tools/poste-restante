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
import { letterIdFromCanonical, canonicaliseWith, resolvePinnedId, resolveSignedId } from "../id.js";
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
   * neither does a key rotation: since 2026-11-08 the identity is pinned at an
   * address's first key registration, so rotation retires a key and moves no
   * id at all (see resolveId; the id a sealed letter was signed under is
   * recovered by the pin, or by the kept pre-pin rule).
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
   * resolved to its DURABLE identity (SPEC §19, amended 2026-11-08), which is
   * the ed25519 fingerprint the address pinned at its first key registration
   * and never moved; legacy addresses without keys resolve to their handle.
   *
   * A sealed letter's signature is ed25519 over the id as of signing, and two
   * rules can name that id, because the archive spans both:
   *
   *   the pin (`resolvePinnedId`) — the identity is durable, so the id is the
   *   same whatever generation signed it. This is what makes a letter sealed to
   *   a recipient who later rotated re-deliver to its ORIGINAL id: the
   *   recipient's rotation no longer moves the id at all.
   *
   *   the pre-pin rule (`resolveSignedId`) — the id re-derived from the LIVE
   *   keys, which is what a client that predates the address book's
   *   `identityId` field computes, and what every stored pre-pin letter was
   *   keyed under. Accepting it is what lets a deployed client keep sealing
   *   across this change.
   *
   * `rejected` means neither rule verifies: no key the sender has ever held
   * covers the letter. The returned id is then the current-resolution id (what
   * the letter would have been keyed as), which is what the logs and the 400
   * name.
   */
  private async resolveId(letter: Letter): Promise<{ id: string; rejected?: boolean }> {
    const identities = await this.identityIds(letter);
    const id = letterIdFromCanonical(canonicaliseWith(letter, identities));
    if (letter.body.format !== "sealed") return { id };

    const history = await this.repo.getAddressKeyHistory(letter.envelope.from);
    const senderKeys = history.map((record) => record.ed25519_public);

    const pinned = resolvePinnedId(
      letter,
      identities,
      senderKeys,
      letter.body.signature,
      verifyLetterId,
    );
    if (pinned !== null) return { id: pinned };

    const legacyIdentities = await this.liveKeyIdentities(letter);
    const legacy = resolveSignedId(
      letter,
      legacyIdentities,
      senderKeys,
      letter.body.signature,
      verifyLetterId,
    );
    return legacy === null ? { id, rejected: true } : { id: legacy };
  }

  /**
   * The DURABLE identity ids for every handle a letter names (SPEC §19,
   * amended 2026-11-08): `addresses.identity_id`, which is pinned at the
   * address's first key registration. A handle with no identity beyond its own
   * label stays absent, and the canonical form keeps it as typed.
   */
  private async identityIds(letter: Letter): Promise<Map<string, string>> {
    const identities = new Map<string, string>();
    for (const handle of this.handles(letter)) {
      const identity = await this.repo.getIdentityId(handle);
      if (identity) identities.set(handle, identity);
    }
    return identities;
  }

  /**
   * The LIVE key resolution — the PRE-PIN rule, for verification only. Each
   * handle resolves to the key the address holds now (a retired key is not
   * where a correspondent seals, and not what a new letter's id resolves to).
   * A client that predates the address book's `identityId` field computes
   * exactly this map, so a letter it sealed still verifies here.
   */
  private async liveKeyIdentities(letter: Letter): Promise<Map<string, string>> {
    const identities = new Map<string, string>();
    for (const handle of this.handles(letter)) {
      const key = await this.repo.getAddressKey(handle);
      if (key) identities.set(handle, key.ed25519_public);
    }
    return identities;
  }

  /** Every handle a letter names — sender, recipients, copies. */
  private handles(letter: Letter): string[] {
    return [
      ...new Set<string>([
        letter.envelope.from,
        ...letter.envelope.to,
        ...letter.envelope.cc,
      ]),
    ];
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
