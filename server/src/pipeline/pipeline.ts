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
import type { PostgresRepository } from "../db/repository.js";
import type { SemanticStore } from "../qdrant/store.js";
import type { Embedder } from "../embed/embedder.js";
import type { PayloadStore } from "../minio/store.js";

export interface IngestResult {
  letterId: string;
  /** True if the letter was newly stored; false if it already existed. */
  created: boolean;
}

export class IngestionPipeline {
  constructor(
    private readonly repo: PostgresRepository,
    private readonly semantic: SemanticStore,
    private readonly embedder: Embedder,
    private readonly payloads: PayloadStore,
    private readonly log: Logger,
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
    const bodyText = markdownToText(letter.body.content);
    const stored: StoredLetter = { ...letter, id, receivedAt, bodyText };

    // 1. Postgres row + links (thread, correspondents, frames).
    await this.repo.storeLetter(stored);
    this.log.info("ingest:stored", { letterId: id, thread: letter.envelope.thread });

    // 2. Embed the plain-text body.
    const vector = await this.embedder.embed(bodyText);
    this.log.info("ingest:embedded", { letterId: id, dimension: vector.length });

    // 3. Qdrant vector.
    await this.semantic.upsert(id, vector);
    this.log.info("ingest:indexed-semantic", { letterId: id });

    // 4. Full-text: the postgres FTS index is maintained by the row insert
    //    (the GIN index on body_text). Nothing further to do here.

    // 5. Payloads are out of scope this phase; the seam is stubbed.
    //    await this.payloads.put(id, ...);

    return { letterId: id, created: true };
  }

  /**
   * Delete a letter from all three tiers. No soft delete — the archive forgets.
   */
  async delete(letterId: string): Promise<boolean> {
    const removed = await this.repo.deleteLetter(letterId);
    if (removed) {
      await this.semantic.delete(letterId);
      this.log.info("ingest:deleted", { letterId });
    }
    return removed;
  }
}
