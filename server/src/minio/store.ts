/**
 * Minio/S3 raw payload store — the third tier of the archive spine.
 *
 * The letter is the unit in all three tiers (postgres row, qdrant vector,
 * minio file). The letter points at the file; whisper transcribes it into
 * a *new* letter. The real store is S3PayloadStore (s3-store.ts); the
 * NoopPayloadStore below is the fallback when MinIO is disabled.
 */
export interface PayloadStore {
  /** Store a raw payload and return its object key. */
  put(letterId: string, name: string, data: Uint8Array, contentType?: string): Promise<string>;
  /** Fetch a raw payload by object key. */
  get(key: string): Promise<Uint8Array | null>;
  /** Delete a raw payload by object key. */
  delete(key: string): Promise<void>;
  /** List all payload keys associated with a letter. */
  listForLetter(letterId: string): Promise<string[]>;
  /** Delete all payloads associated with a letter (tier 3 cascade). */
  deleteForLetter(letterId: string): Promise<void>;
}

/**
 * A no-op payload store. It records nothing and returns null on read — the
 * fallback when MinIO is disabled (the house runs on postgres + qdrant
 * alone). It exists so the archive spine has a stable seam whether or not
 * the raw-payload tier is configured.
 */
export class NoopPayloadStore implements PayloadStore {
  async put(_letterId: string, _name: string, _data: Uint8Array, _contentType?: string): Promise<string> {
    throw new Error("payload store is disabled — MinIO is not configured");
  }
  async get(_key: string): Promise<Uint8Array | null> {
    return null;
  }
  async delete(_key: string): Promise<void> {
    // Nothing to delete — the stub holds nothing.
  }
  async listForLetter(_letterId: string): Promise<string[]> {
    return [];
  }
  async deleteForLetter(_letterId: string): Promise<void> {
    // Nothing to delete — the stub holds nothing.
  }
}

