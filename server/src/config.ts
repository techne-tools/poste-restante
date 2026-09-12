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
  /** Minio/S3 endpoint for raw payloads. */
  minioEndpoint: string;
  /** Minio/S3 bucket for raw payloads. Default 'letters'. */
  minioBucket: string;
  /** Minio/S3 access key id (unset = no credentials / anonymous). */
  minioAccessKey: string | undefined;
  /** Minio/S3 secret access key. */
  minioSecretKey: string | undefined;
  /** Minio/S3 region. Default 'us-east-1'. */
  minioRegion: string;
  /** Whether S3 payload store is enabled (true if access keys or MINIO_ENABLED=1). */
  minioEnabled: boolean;
  /** Redis URL for ingestion queue and pub/sub (e.g. redis://localhost:6379/0). */
  redisUrl: string | undefined;
  /** Faster-whisper ASR web service URL (e.g. http://localhost:9000). */
  whisperUrl: string | undefined;
  /** Whether to run integration tests against live infra. */
  integration: boolean;
  /** Authentication configuration. */
  auth: AuthConfig;
  /** The house book's settling period — how long a clause must stand
   *  unopposed before it becomes the household's norm. Slow by
   *  construction; configurable per house. */
  bookSettlingDays: number;
  /** The heartbeat of the gap engine — how often the scheduled pass runs
   *  detectGaps per resident. 0 disables the scheduler (the house only
   *  detects on demand). Default 6 hours. */
  gapPassIntervalMs: number;
  /** The SMTP door (SPEC §5 #10) — inbound mail becomes letters. Closed by
   *  default; local submission only; refuses to start with AUTH_MODE=none. */
  smtpEnabled: boolean;
  /** The SMTP bind address ("127.0.0.1:2525"). */
  smtpBind: string;
  /** The outbound seam (SPEC §5 #13) — letters addressed outside the house
   *  are relayed outward. A mailto-style SMTP URL ("smtp://user:pass@relay:587/").
   *  Unset = the door stays closed; the seam ships dormant until a relay is
   *  chosen. Credentials never appear in config — they live in the URL. */
  smtpOutboundUrl: string | undefined;
  /** The address-space boundary: addresses whose domain equals this are the
   *  house's own; everyone else is external and relayable (SPEC §5 #13). */
  houseDomain: string;
  /** The community's names for the rooms (SPEC §5 #14). The addresses stay
   *  protocol-stable (`@house` — hashing, dedup, OIDC bindings); the serif
   *  voice on the page is the community's. An Islamic community, an
   *  addiction group, a study circle — the words they see are their own.
   *  Defaults are the house's founding vocabulary; operators may rename
   *  the rooms without renaming the architecture. */
  houseName: string;
  /** The public room's name — what the serif voice calls the pub. */
  pubName: string;
  /** The commons' name — what the serif voice calls the book. */
  bookName: string;
  /** The remaining rooms' names — the nav and the whisper sidebar read from
   *  these, so a community renames every room, not just the three above. */
  mailboxName: string;
  archiveName: string;
  addressesName: string;
  profileName: string;
  writeName: string;
  whisperName: string;
  /** The community's name for the day board (SPEC §18) — the whiteboard
   *  room, a place-word like "the book". Default "the day". */
  dayName: string;
  /** Whether GET /v1/house/meta is keyless (default true) or requires a
   *  credential (HOUSE_META_PUBLIC=0). The payload is no sensitive state —
   *  room names, the domain, the house's public keys — so the keyless door
   *  can speak the community's own names. A keyed house answers 401 and the
   *  door falls back to the founding vocabulary. */
  houseMetaPublic: boolean;
  /** The mailbox sync heartbeat (SPEC §5 #12, the sync drive): how often
   *  the scheduled re-pass re-mirrors provisioned mailbox accounts. 0
   *  disables the scheduler — the house only syncs on start and on each
   *  stored letter. Default 0 (dormant). */
  mailboxSyncIntervalMs: number;
  /** DEV-ONLY: accept the dev/homelab sidecar's self-signed cert for
   *  plaintext imap:// URLs (MAILBOX_TLS_INSECURE=1). Production configures
   *  the CA via imaps:// and never sets this. Fail closed by default. */
  mailboxTlsInsecure: boolean;
  /** The agent death sweep rhythm (AGENT_SWEEP_INTERVAL_MS). Agents with
   *  a lifespan frame close when the frame has been quiet for the
   *  activity window — the house kills no zombies and revokes their
   *  tokens on its own breath. Default 6h. 0 disables the sweep. */
  agentSweepIntervalMs: number;
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
    minioBucket: env.MINIO_BUCKET ?? "letters",
    minioAccessKey: env.MINIO_ACCESS_KEY || undefined,
    minioSecretKey: env.MINIO_SECRET_KEY || undefined,
    minioRegion: env.MINIO_REGION ?? "us-east-1",
    minioEnabled:
      boolFromEnv(env.MINIO_ENABLED, false) ||
      Boolean(env.MINIO_ACCESS_KEY && env.MINIO_SECRET_KEY),
    redisUrl: env.REDIS_URL || undefined,
    whisperUrl: env.WHISPER_URL || undefined,
    integration: boolFromEnv(env.POSTE_RESTANTE_INTEGRATION, false),
    auth,
    bookSettlingDays: intFromEnv(env.BOOK_SETTLING_DAYS, 7),
    gapPassIntervalMs: intFromEnv(env.GAP_PASS_INTERVAL_MS, 6 * 60 * 60 * 1000),
    smtpEnabled: boolFromEnv(env.SMTP_ENABLED, false),
    smtpBind: env.SMTP_BIND ?? "127.0.0.1:2525",
    smtpOutboundUrl: env.SMTP_OUTBOUND_URL || undefined,
    houseDomain: env.HOUSE_DOMAIN ?? "house",
    houseName: env.HOUSE_NAME ?? "Poste Restante",
    pubName: env.PUB_NAME ?? "the pub",
    bookName: env.BOOK_NAME ?? "the book",
    mailboxName: env.MAILBOX_NAME ?? "the mailbox",
    archiveName: env.ARCHIVE_NAME ?? "the archive",
    addressesName: env.ADDRESSES_NAME ?? "the address book",
    profileName: env.PROFILE_NAME ?? "your record",
    writeName: env.WRITE_NAME ?? "the writing desk",
    whisperName: env.WHISPER_NAME ?? "the whisper",
    dayName: env.DAY_NAME ?? "the day",
    houseMetaPublic: boolFromEnv(env.HOUSE_META_PUBLIC, true),
    mailboxSyncIntervalMs: intFromEnv(env.MAILBOX_SYNC_INTERVAL_MS, 0),
    mailboxTlsInsecure: boolFromEnv(env.MAILBOX_TLS_INSECURE, false),
    agentSweepIntervalMs: intFromEnv(env.AGENT_SWEEP_INTERVAL_MS, 6 * 60 * 60 * 1000),
  };
}
