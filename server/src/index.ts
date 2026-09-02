/**
 * Poste Restante — the archive spine. Public surface of the server package.
 *
 * This is the headless house: primitives as a protocol, no UI, no web server,
 * no push channel. The letter server (phase 4b) is a client of this spine.
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
export { RedeemSchema } from "./schemas.js";
export type { House } from "./house.js";

import { loadConfig } from "./config.js";
import { connectDbAndMigrate } from "./db/index.js";
import { PostgresRepository } from "./db/repository.js";
import { createEmbedder } from "./embed/embedder.js";
import { QdrantSemanticStore } from "./qdrant/store.js";
import { NoopPayloadStore } from "./minio/store.js";
import { IngestionPipeline } from "./pipeline/pipeline.js";
import { Retrieval } from "./retrieval/retrieval.js";
import { WhisperService } from "./whisper/service.js";
import { ParticipationService } from "./participation/service.js";
import { BookService } from "./book/service.js";
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
  const payloads = new NoopPayloadStore();
  // The participation hook is a closure over a late-bound service — the
  // pipeline is the single write path, and the ParticipationService uses
  // the pipeline to write its own letters. By the time any letter is
  // ingested, `participation` is assigned.
  let participation: ParticipationService;
  const pipeline = new IngestionPipeline(
    repo,
    semantic,
    embedder,
    payloads,
    log,
    (letter) => participation.record(letter),
  );
  const retrieval = new Retrieval(db.pool, semantic, embedder);
  const whisper = new WhisperService(db.pool, log, semantic, embedder);
  participation = new ParticipationService(db.pool, pipeline, log);
  const book = new BookService(
    db.pool,
    pipeline,
    repo,
    log,
    config.bookSettlingDays,
  );

  return {
    config,
    db,
    repo,
    semantic,
    embedder,
    payloads,
    pipeline,
    retrieval,
    whisper,
    participation,
    book,
    log,
    async close() {
      await db.close();
    },
  };
}
