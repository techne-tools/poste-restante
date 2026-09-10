/**
 * Poste Restante — the archive spine. Public surface of the server package.
 *
 * This is the headless house: primitives as a protocol, no UI, no web server,
 * no push channel. The letter server (server.ts) is a client of this spine.
 */
export * from "./types.js";
export { letterId, canonicalise } from "./id.js";
export { loadConfig, type HouseConfig, type EmbeddingConfig } from "./config.js";
export { connectDb, connectDbAndMigrate, type Db } from "./db/index.js";
export { migrate, type MigrationResult } from "./db/migrate.js";
export { PostgresRepository, type LetterRow, type StoredLetterRow } from "./db/repository.js";
export { createEmbedder, OpenAICompatibleEmbedder, type Embedder } from "./embed/embedder.js";
export { QdrantSemanticStore, type SemanticStore, type SemanticHit } from "./qdrant/store.js";
export { NoopPayloadStore, type PayloadStore } from "./minio/store.js";
export { IngestionPipeline, type IngestResult } from "./pipeline/pipeline.js";
export { markdownToText } from "./pipeline/markdown.js";
export { createLogger, silentLogger, type Logger } from "./pipeline/logger.js";
export { Retrieval, rrf, type RetrievalQuery, type RetrievalHit } from "./retrieval/retrieval.js";
export { WhisperService, type Whisper, type WhisperKind } from "./whisper/service.js";
export {
  GapScheduler,
  startGapScheduler,
  type GapSchedulerDeps,
} from "./whisper/scheduler.js";
export {
  startSmtpBridge,
  translateMail,
  normalizeSubject,
  deterministicThread,
  parseBind,
  type SmtpBridge,
  type SmtpMailLetter,
} from "./bridge/smtp.js";
export { findThreadBySubject } from "./bridge/threads.js";
export {
  uidForLetter,
  frameFolder,
  folderForLetter,
  translateToMailbox,
  INBOX,
  SENT,
  ARCHIVE,
  type MailboxFolder,
  type MailFlagState,
  type FolderInput,
  type MailboxTranslationInput,
  type MailboxLetter,
} from "./bridge/mailbox.js";
export {
  MailboxSync,
  buildMailboxView,
  toRfc5322Message,
  deriveMailFlags,
  flagsToImap,
  toMailFlagState,
  type MailboxSyncSource,
  type MailboxWriter,
  type Rfc5322Message,
  type MailboxViewInput,
} from "./bridge/sync.js";
export {
  ImapMailboxWriter,
  parseImapUrl,
} from "./bridge/imap-writer.js";
export {
  MailboxAccountsService,
  type MailboxAccount,
} from "./bridge/mailbox-accounts.js";
export {
  MailboxSyncDrive,
  type MailboxSyncDriveDeps,
  type MailboxPassResult,
} from "./bridge/mailbox-drive.js";
export {
  startOutbound,
  translateToMail,
  externalRecipients,
  isInternalAddress,
  parseSmtpUrl,
  isOwnDoor,
  type OutboundRelay,
  type OutboundDeps,
} from "./bridge/outbound.js";
export {
  ParticipationService,
  type ParticipationState,
  type ParticipationRow,
} from "./participation/service.js";
export {
  InviteService,
  generateInviteCode,
  hashInviteCode,
  type MintedInvite,
  type RedeemInput,
} from "./invites/service.js";
export {
  BookService,
  BOOK_ADDRESS,
  PUB_DOOR,
  deriveClause,
  type ClauseAction,
  type ClauseState,
  type DerivedClause,
  type BookHead,
} from "./book/service.js";
export {
  parseClauseFrontmatter,
  stripClauseFrontmatter,
  isClauseLetter,
  CLAUSE_ROLES,
  type ClauseFrontmatter,
  type ClauseRole,
} from "./book/frontmatter.js";
export { S3PayloadStore, type S3PayloadStoreOptions } from "./minio/s3-store.js";
export {
  createIngestionQueue,
  DirectIngestionQueue,
  RedisIngestionQueue,
  type IngestionQueue,
  type IngestHandler,
  type RedisQueueOptions,
} from "./queue/queue.js";
export {
  createHouseEventBus,
  MemoryHouseEventBus,
  RedisHouseEventBus,
  type HouseEventBus,
  type HouseEvent,
  type EventHandler,
} from "./queue/pubsub.js";
export {
  createAudioTranscriber,
  NoopAudioTranscriber,
  WhisperTranscriber,
  type AudioTranscriber,
  type TranscribeResult,
} from "./audio/transcriber.js";
export {
  AudioLetterService,
  type AudioLetterServiceOptions,
} from "./audio/audio-service.js";
export { RedeemSchema } from "./schemas.js";
export type { House } from "./house.js";

import { loadConfig } from "./config.js";
import { connectDbAndMigrate } from "./db/index.js";
import { PostgresRepository } from "./db/repository.js";
import { createEmbedder } from "./embed/embedder.js";
import { QdrantSemanticStore } from "./qdrant/store.js";
import { NoopPayloadStore, type PayloadStore } from "./minio/store.js";
import { S3PayloadStore } from "./minio/s3-store.js";
import { IngestionPipeline } from "./pipeline/pipeline.js";
import { startOutbound, type OutboundRelay } from "./bridge/outbound.js";
import { MailboxAccountsService } from "./bridge/mailbox-accounts.js";
import { MailboxSyncDrive } from "./bridge/mailbox-drive.js";
import { Retrieval } from "./retrieval/retrieval.js";
import { WhisperService } from "./whisper/service.js";
import { ParticipationService } from "./participation/service.js";
import { BookService } from "./book/service.js";
import { AgentService } from "./agents/service.js";
import { IntegrationService } from "./integrations/service.js";
import { DayProjectionService } from "./day/projection.js";
import { LetterReadsService } from "./reads/service.js";
import { createIngestionQueue } from "./queue/queue.js";
import { createHouseEventBus } from "./queue/pubsub.js";
import { createAudioTranscriber } from "./audio/transcriber.js";
import { AudioLetterService } from "./audio/audio-service.js";
import { createLogger, silentLogger, type Logger } from "./pipeline/logger.js";

/**
 * Build the full archive spine from the environment. Connects to postgres
 * (applying migrations), ensures the qdrant collection, and wires the pipeline
 * and retrieval together. Call `close()` when done.
 */
export async function buildHouse(
  env: NodeJS.ProcessEnv = process.env,
  log: Logger = createLogger(),
) {
  const config = loadConfig(env);
  const db = await connectDbAndMigrate(config.databaseUrl);
  const embedder = createEmbedder(config.embedding);
  const semantic = new QdrantSemanticStore(
    config.qdrantUrl,
    config.qdrantCollection,
    embedder,
  );
  await semantic.ensureCollection();
  const repo = new PostgresRepository(db.pool);

  // 1. Raw Payloads tier (SPEC §3.1 / §3.2)
  const payloads: PayloadStore = config.minioEnabled
    ? new S3PayloadStore({
        endpoint: config.minioEndpoint,
        bucket: config.minioBucket,
        region: config.minioRegion,
        accessKeyId: config.minioAccessKey,
        secretAccessKey: config.minioSecretKey,
      })
    : new NoopPayloadStore();

  if (config.minioEnabled && payloads instanceof S3PayloadStore) {
    await payloads.ensureBucket().catch((err) => {
      log.error("minio:ensure-bucket-failed", {
        bucket: config.minioBucket,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  // 2. Ingestion Queue & PubSub tier (SPEC §3.1 / §3.2)
  const eventBus = createHouseEventBus(config.redisUrl, log);

  // 3. Audio Letters / faster-whisper ASR tier (CONTRACT.md / SPEC §3.1)
  const transcriber = createAudioTranscriber(config.whisperUrl, log);
  let audio: AudioLetterService;

  // The participation hook is a closure over a late-bound service — the
  // pipeline is the single write path, and the ParticipationService uses
  // the pipeline to write its own letters. By the time any letter is
  // ingested, `participation` is assigned.
  let participation: ParticipationService;
  // The outbound relay (SPEC §5 #13) is late-bound the same way: the
  // pipeline is the single write path, the relay rides the onStored hook;
  // by the time any letter is ingested, `outbound` is assigned.
  let outbound: OutboundRelay | null;
  // The mailbox sync drive (SPEC §5 #12) rides the same hook — after any
  // stored letter, the residents party to it (via their provisioned
  // mailbox accounts) re-converge. Late-bound like the others: the drive
  // uses the pipeline-adjacent services but never the other way round.
  let mailbox: MailboxSyncDrive | null = null;
  const pipeline = new IngestionPipeline(
    repo,
    semantic,
    embedder,
    payloads,
    log,
    (letter) => participation.record(letter),
    (letter) => {
      const relays = outbound?.enabled ? outbound.relay(letter) : Promise.resolve(undefined);
      const syncs = mailbox ? mailbox.onStored() : Promise.resolve(undefined);
      const events = eventBus.publish({
        type: "letter:stored",
        letterId: letter.id ?? "",
        thread: letter.envelope.thread,
        kind: letter.envelope.kind,
      });
      // If an audio letter arrives and whisper is configured, transcribe it
      if (letter.envelope.kind === "audio" && config.whisperUrl) {
        void audio?.transcribeAudioLetter(letter).catch((err) => {
          log.error("audio:transcribe-on-stored-failed", {
            letterId: letter.id,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
      return Promise.all([relays, syncs, events]).then(() => undefined);
    },
  );

  const queue = createIngestionQueue(
    config.redisUrl,
    (letter) => pipeline.ingest(letter),
    log,
  );
  await queue.start();

  audio = new AudioLetterService({
    payloadStore: payloads,
    transcriber,
    ingest: (letter) => pipeline.ingest(letter),
    log,
  });

  const retrieval = new Retrieval(db.pool, semantic, embedder);
  const whisper = new WhisperService(db.pool, log, semantic, embedder);
  participation = new ParticipationService(db.pool, pipeline, log);
  outbound = startOutbound({ config, log });
  mailbox = new MailboxSyncDrive(
    {
      accounts: new MailboxAccountsService(db.pool),
      repo,
      log,
      tlsInsecure: config.mailboxTlsInsecure,
    },
    config.mailboxSyncIntervalMs,
  );
  const book = new BookService(
    db.pool,
    pipeline,
    repo,
    log,
    config.bookSettlingDays,
  );
  const agents = new AgentService(db.pool, repo, pipeline, log);
  const integrations = new IntegrationService(db.pool, pipeline, log);
  const day = new DayProjectionService(db.pool, whisper, book);
  const reads = new LetterReadsService(db.pool);

  return {
    config,
    db,
    repo,
    semantic,
    embedder,
    payloads,
    pipeline,
    queue,
    eventBus,
    transcriber,
    audio,
    retrieval,
    whisper,
    participation,
    outbound,
    mailbox,
    book,
    agents,
    integrations,
    day,
    reads,
    log,
    async close() {
      await queue.stop();
      await eventBus.close();
      outbound?.close();
      mailbox?.stop();
      await db.close();
    },
  };
}

