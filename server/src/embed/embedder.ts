/**
 * Embedding. Local by default (Ollama); cloud as an explicit opt-in via one
 * env var (`EMBEDDING_BASE_URL`). A cloud key is never hardcoded — it is read
 * from `EMBEDDING_API_KEY` if the operator chooses to set it.
 *
 * Both Ollama and OpenAI-compatible endpoints expose the same
 * `/v1/embeddings` shape, so one client serves both. The only difference is
 * the base URL and an optional bearer token.
 */
import type { EmbeddingConfig } from "../config.js";

export interface Embedder {
  /** Embed a single text into a vector of `dimension` floats. */
  embed(text: string): Promise<number[]>;
  /** Embed many texts in one request. */
  embedMany(texts: string[]): Promise<number[][]>;
  readonly dimension: number;
}

interface EmbeddingsResponse {
  data: { embedding: number[] }[];
}

export class OpenAICompatibleEmbedder implements Embedder {
  readonly dimension: number;
  private readonly baseUrl: string;
  private readonly model: string;
  private readonly apiKey?: string;

  constructor(config: EmbeddingConfig) {
    this.dimension = config.dimension;
    this.model = config.model;
    // Local default: Ollama. Cloud opt-in: the operator sets EMBEDDING_BASE_URL.
    this.baseUrl = (config.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    this.apiKey = config.apiKey;
  }

  private async request(texts: string[]): Promise<number[][]> {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    if (this.apiKey) headers["Authorization"] = `Bearer ${this.apiKey}`;

    const res = await fetch(`${this.baseUrl}/v1/embeddings`, {
      method: "POST",
      headers,
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `embedding request failed (${res.status}): ${body.slice(0, 300)}`,
      );
    }
    const json = (await res.json()) as EmbeddingsResponse;
    return json.data.map((d) => d.embedding);
  }

  async embed(text: string): Promise<number[]> {
    const [vec] = await this.request([text]);
    if (!vec) throw new Error("embedding request returned no vector");
    return vec;
  }

  async embedMany(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];
    return this.request(texts);
  }
}

export function createEmbedder(config: EmbeddingConfig): Embedder {
  return new OpenAICompatibleEmbedder(config);
}
