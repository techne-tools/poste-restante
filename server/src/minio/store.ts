/**
 * Minio/S3 raw payload store — STUBBED this phase.
 *
 * The brief scopes raw payloads (audio, video, images) out of phase 4a. The
 * letter is the unit in all three tiers (postgres row, qdrant vector, minio
 * file), so the interface is defined now and the implementation lands with the
 * payload pipeline. The letter points at the file; whisper transcribes it into
 * a *new* letter.
 */
export interface PayloadStore {
  /** Store a raw payload and return its object key. */
  put(letterId: string, name: string, data: Uint8Array): Promise<string>;
  /** Fetch a raw payload by object key. */
  get(key: string): Promise<Uint8Array | null>;
  /** Delete a raw payload by object key. */
  delete(key: string): Promise<void>;
}

/**
 * A no-op payload store. It records nothing and returns null on read — the
 * honest stub for a phase where payloads are out of scope. It exists so the
 * archive spine has a stable seam to attach the real S3 store to in phase 4b.
 */
export class NoopPayloadStore implements PayloadStore {
  async put(_letterId: string, _name: string, _data: Uint8Array): Promise<string> {
    throw new Error("payload store is stubbed in phase 4a — payloads are out of scope");
  }
  async get(_key: string): Promise<Uint8Array | null> {
    return null;
  }
  async delete(_key: string): Promise<void> {
    // Nothing to delete — the stub holds nothing.
  }
}
