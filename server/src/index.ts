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
export type { House } from "./house.js";

import { loadConfig } from "./config.js";
import { connectDbAndMigrate } from "./db/index.js";
import { PostgresRepository } from "./db/repository.js";
import { createEmbedder } from "./embed/embedder.js";
import { QdrantSemanticStore } from "./qdrant/store.js";
import { NoopPayloadStore } from "./minio/store.js";
import { IngestionPipeline } from "./pipeline/pipeline.js";
import { Retrieval } from "./retrieval/retrieval.js";
import { createLogger } from "./pipeline/logger.js";

/**
 * Build the full archive spine from the environment. Connects to postgres
 * (applying migrations), ensures the qdrant collection, and wires the pipeline
 * and retrieval together. Call `close()` when done.
 */
export async function buildHouse(env: NodeJS.ProcessEnv = process.env) {
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
  const log = createLogger();
  const pipeline = new IngestionPipeline(repo, semantic, embedder, payloads, log);
  const retrieval = new Retrieval(db.pool, semantic, embedder);

  return {
    config,
    db,
    repo,
    semantic,
    embedder,
    payloads,
    pipeline,
    retrieval,
    log,
    async close() {
      await db.close();
    },
  };
}
