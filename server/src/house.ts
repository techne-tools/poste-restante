/**
 * The House — the assembled archive spine. The letter server (phase 4b) is a
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

export interface House {
  config: HouseConfig;
  db: Db;
  repo: PostgresRepository;
  semantic: SemanticStore;
  embedder: Embedder;
  payloads: PayloadStore;
  pipeline: IngestionPipeline;
  retrieval: Retrieval;
  log: Logger;
  close(): Promise<void>;
}
