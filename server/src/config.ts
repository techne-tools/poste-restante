/**
 * House configuration. Everything is environment-driven, local by default.
 *
 * The only cloud switch is the embedding endpoint: `EMBEDDING_BASE_URL`.
 * When unset, the house uses local Ollama. When set to an OpenAI-compatible
 * endpoint, the house uses that instead. A cloud key is never hardcoded — it
 * is read from `EMBEDDING_API_KEY` if the operator chooses to set it.
 */
import { z } from "zod";
import type { AuthConfig } from "./auth/service.js";

const boolFromEnv = (v: string | undefined, dflt: boolean): boolean => {
  if (v === undefined) return dflt;
  return v === "1" || v.toLowerCase() === "true" || v.toLowerCase() === "yes";
};

const intFromEnv = (v: string | undefined, dflt: number): number => {
  if (v === undefined) return dflt;
  const n = Number.parseInt(v, 10);
  return Number.isNaN(n) ? dflt : n;
};

const EmbeddingConfigSchema = z.object({
  /** The embedding model name. Local default is the Ollama nomic-embed-text. */
  model: z.string().default("nomic-embed-text"),
  /** The embedding dimension. nomic-embed-text is 768. */
  dimension: z.number().int().positive().default(768),
  /** The OpenAI-compatible base URL. Unset = local Ollama. */
  baseUrl: z.string().url().optional(),
  /** Optional API key for a cloud endpoint. Never hardcoded. */
  apiKey: z.string().optional(),
});

export type EmbeddingConfig = z.infer<typeof EmbeddingConfigSchema>;

export interface HouseConfig {
  /** Postgres connection. */
  databaseUrl: string;
  /** Qdrant base URL. */
  qdrantUrl: string;
  /** The qdrant collection that holds letter vectors. */
  qdrantCollection: string;
  /** Embedding configuration. */
  embedding: EmbeddingConfig;
  /** Minio/S3 endpoint for raw payloads (stubbed this phase). */
  minioEndpoint: string;
  /** Whether to run integration tests against live infra. */
  integration: boolean;
  /** Authentication configuration. */
  auth: AuthConfig;
  /** The house book's settling period — how long a clause must stand
   *  unopposed before it becomes the household's norm. Slow by
   *  construction; configurable per house. */
  bookSettlingDays: number;
}

const AuthConfigSchema = z.object({
  /** 'basic' | 'oidc' | 'both' | 'none' (none = development only). */
  mode: z.enum(["basic", "oidc", "both", "none"]).default("none"),
  oidc: z
    .object({
      issuer: z.string().url(),
      clientId: z.string().min(1),
      clientSecret: z.string().min(1),
      redirectUri: z.string().url(),
      ownerAddress: z.string().min(1),
    })
    .optional(),
});

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HouseConfig {
  const embedding = EmbeddingConfigSchema.parse({
    model: env.EMBEDDING_MODEL,
    dimension: intFromEnv(env.EMBEDDING_DIMENSION, 768),
    baseUrl: env.EMBEDDING_BASE_URL || undefined,
    apiKey: env.EMBEDDING_API_KEY || undefined,
  });

  const auth = AuthConfigSchema.parse({
    mode: env.AUTH_MODE ?? "none",
    oidc:
      env.OIDC_ISSUER && env.OIDC_CLIENT_ID && env.OIDC_CLIENT_SECRET && env.OIDC_REDIRECT_URI
        ? {
            issuer: env.OIDC_ISSUER,
            clientId: env.OIDC_CLIENT_ID,
            clientSecret: env.OIDC_CLIENT_SECRET,
            redirectUri: env.OIDC_REDIRECT_URI,
            ownerAddress: env.OIDC_OWNER_ADDRESS ?? "you@house",
          }
        : undefined,
  });

  return {
    databaseUrl:
      env.DATABASE_URL ??
      "postgres://localhost:5433/poste_restante",
    qdrantUrl: env.QDRANT_URL ?? "http://localhost:6333",
    qdrantCollection: env.QDRANT_COLLECTION ?? "letters",
    embedding,
    minioEndpoint: env.MINIO_ENDPOINT ?? "http://localhost:9000",
    integration: boolFromEnv(env.POSTE_RESTANTE_INTEGRATION, false),
    auth,
    bookSettlingDays: intFromEnv(env.BOOK_SETTLING_DAYS, 7),
  };
}
