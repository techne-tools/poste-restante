/**
 * The House — the assembled archive spine. The letter server (server.ts) is a
 * thin client over this. `buildHouse()` returns exactly this shape.
 */
import type { HouseConfig } from "./config.js";
import type { Db } from "./db/index.js";
import type { PostgresRepository } from "./db/repository.js";
import type { Embedder } from "./embed/embedder.js";
import type { SemanticStore } from "./qdrant/store.js";
import type { PayloadStore } from "./minio/store.js";
import type { IngestionPipeline } from "./pipeline/pipeline.js";
import type { Logger } from "./pipeline/logger.js";
import type { Retrieval } from "./retrieval/retrieval.js";
import type { WhisperService } from "./whisper/service.js";
import type { ParticipationService } from "./participation/service.js";
import type { BookService } from "./book/service.js";
import type { AgentService } from "./agents/service.js";
import type { IntegrationService } from "./integrations/service.js";
import type { OutboundRelay } from "./bridge/outbound.js";
import type { MailboxSyncDrive } from "./bridge/mailbox-drive.js";

export interface House {
  config: HouseConfig;
  db: Db;
  repo: PostgresRepository;
  semantic: SemanticStore;
  embedder: Embedder;
  payloads: PayloadStore;
  pipeline: IngestionPipeline;
  retrieval: Retrieval;
  whisper: WhisperService;
  participation: ParticipationService;
  book: BookService;
  /** Agents — instruments, not servants (SPEC §16). */
  agents: AgentService;
  /** External tool integrations (SPEC §17, direction B). */
  integrations: IntegrationService;
  /** Ingestion queue for letters (Direct or Redis). */
  queue: import("./queue/queue.js").IngestionQueue;
  /** Event bus for house events (Memory or Redis pub/sub). */
  eventBus: import("./queue/pubsub.js").HouseEventBus;
  /** Audio letter transcription service (SPEC §3.1 / §3.2). */
  audio: import("./audio/audio-service.js").AudioLetterService;
  /** Audio transcriber client for faster-whisper. */
  transcriber: import("./audio/transcriber.js").AudioTranscriber;
  /** The outbound relay (SPEC §5 #13) — null when dormant/refused. */
  outbound: OutboundRelay | null;
  /** The mailbox sync drive (SPEC §5 #12) — null when no accounts
   *  provisioned; the house syncs when it has mailboxes to sync. */
  mailbox: MailboxSyncDrive | null;
  log: Logger;
  close(): Promise<void>;
}
