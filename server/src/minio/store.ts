/**
 * Minio/S3 raw payload store — the third tier of the archive spine.
 *
 * The letter is the unit in all three tiers (postgres row, qdrant vector,
 * minio file). The letter points at the file; whisper transcribes it into
 * a *new* letter. The real store is S3PayloadStore (s3-store.ts); the
 * NoopPayloadStore below is the fallback when MinIO is disabled.
 *
 * The store moves bytes and nothing else. It does not know about seals:
 * a sealed payload arrives here already encrypted by its writer, and the
 * house stores the ciphertext verbatim. There is no decryption method on
 * this interface, and there must not be one (SPEC §15 — the house cannot
 * read what it sealed; PLAN-crypto.md C1).
 */

/** What the store hands back after a streamed write. */
export interface StoredPayload {
  /** The object key (`letters/<id>/<name>`). */
  key: string;
  /** The number of bytes actually written. */
  size: number;
}

export interface PayloadStore {
  /** Store a raw payload and return its object key. */
  put(letterId: string, name: string, data: Uint8Array, contentType?: string): Promise<string>;
  /**
   * Store a payload from a stream. The caller owns bounds and framing;
   * the store writes what it is given and reports how much it wrote.
   * `sizeHint` is the client's declared length when it sent one — the
   * store uses it to stream straight through instead of spooling.
   */
  putStream(
    letterId: string,
    name: string,
    body: ReadableStream<Uint8Array>,
    contentType?: string,
    sizeHint?: number,
  ): Promise<StoredPayload>;
  /** Fetch a raw payload by object key. */
  get(key: string): Promise<Uint8Array | null>;
  /** Delete a raw payload by object key. */
  delete(key: string): Promise<void>;
  /** List all payload keys associated with a letter. */
  listForLetter(letterId: string): Promise<string[]>;
  /** Delete all payloads associated with a letter (tier 3 cascade). */
  deleteForLetter(letterId: string): Promise<void>;
}

export class NoopPayloadStore implements PayloadStore {
  async put(_letterId: string, _name: string, _data: Uint8Array, _contentType?: string): Promise<string> {
    throw new Error("payload store is disabled — MinIO is not configured");
  }
  async putStream(
    _letterId: string,
    _name: string,
    _body: ReadableStream<Uint8Array>,
    _contentType?: string,
    _sizeHint?: number,
  ): Promise<StoredPayload> {
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
