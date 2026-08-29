/**
 * Qdrant semantic layer. The letter is the unit: one vector per letter, keyed
 * by the letter id. The vector is the embedding of the letter's plain-text body.
 */
import { QdrantClient } from "@qdrant/js-client-rest";
import type { Embedder } from "../embed/embedder.js";

export interface SemanticHit {
  letterId: string;
  score: number;
}

/**
 * Qdrant point ids must be a UUID or an unsigned integer — a 64-char sha256 hex
 * string is neither. We map the letter id (sha256 hex) to a deterministic UUID
 * by taking the first 32 hex chars and formatting them as a UUID. The full
 * letter id is stored as a payload so it survives the round-trip.
 */
export function letterIdToPointId(letterId: string): string {
  const hex = letterId.slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export interface SemanticStore {
  /** Ensure the collection exists with the right vector size. */
  ensureCollection(): Promise<void>;
  /** Upsert a letter's vector. */
  upsert(letterId: string, vector: number[]): Promise<void>;
  /** Delete a letter's vector. */
  delete(letterId: string): Promise<void>;
  /** Search for the nearest letters to a query vector. */
  search(vector: number[], limit: number): Promise<SemanticHit[]>;
  /** Delete the whole collection (used in tests). */
  reset(): Promise<void>;
}

export class QdrantSemanticStore implements SemanticStore {
  private readonly client: QdrantClient;
  private readonly collection: string;
  private readonly embedder: Embedder;

  constructor(qdrantUrl: string, collection: string, embedder: Embedder) {
    this.client = new QdrantClient({ url: qdrantUrl });
    this.collection = collection;
    this.embedder = embedder;
  }

  async ensureCollection(): Promise<void> {
    const exists = await this.client.collectionExists(this.collection);
    if (exists.exists) return;
    await this.client.createCollection(this.collection, {
      vectors: { size: this.embedder.dimension, distance: "Cosine" },
    });
  }

  async upsert(letterId: string, vector: number[]): Promise<void> {
    await this.client.upsert(this.collection, {
      points: [{ id: letterIdToPointId(letterId), vector, payload: { letterId } }],
    });
  }

  async delete(letterId: string): Promise<void> {
    await this.client.delete(this.collection, {
      points: [letterIdToPointId(letterId)],
    });
  }

  async search(vector: number[], limit: number): Promise<SemanticHit[]> {
    const res = await this.client.query(this.collection, {
      query: vector,
      limit,
      with_payload: true,
    });
    return res.points.map((hit) => ({
      letterId: String((hit.payload as { letterId?: string } | undefined)?.letterId ?? hit.id),
      score: hit.score ?? 0,
    }));
  }

  async reset(): Promise<void> {
    await this.client.deleteCollection(this.collection).catch(() => undefined);
  }
}
