import { Redis } from "ioredis";
import type { Letter } from "../types.js";
import type { IngestResult } from "../pipeline/pipeline.js";
import type { Logger } from "../pipeline/logger.js";

/**
 * Ingestion queue interface for letter arrival.
 *
 * Ephemeral state / queueing layer (SPEC §3.1 / §3.2).
 * Allows letters arriving from HTTP, SMTP, or agents to be ingested
 * either synchronously (direct) or asynchronously via Redis.
 */
export interface IngestionQueue {
  /** Enqueue a letter for ingestion. */
  enqueue(letter: Letter): Promise<void>;
  /** Start the queue consumer worker (if asynchronous). */
  start(): Promise<void>;
  /** Stop the queue consumer worker and disconnect. */
  stop(): Promise<void>;
  /** Whether the queue consumer is active. */
  readonly isRunning: boolean;
}

export type IngestHandler = (letter: Letter) => Promise<IngestResult>;

/**
 * Direct synchronous queue. Letters are ingested immediately on enqueue.
 * Used for development, tests, and when REDIS_URL is unset.
 */
export class DirectIngestionQueue implements IngestionQueue {
  private running = true;

  constructor(
    private readonly ingest: IngestHandler,
    private readonly log?: Logger,
  ) {}

  get isRunning(): boolean {
    return this.running;
  }

  async enqueue(letter: Letter): Promise<void> {
    if (!this.running) {
      throw new Error("Ingestion queue is stopped");
    }
    await this.ingest(letter);
  }

  async start(): Promise<void> {
    this.running = true;
  }

  async stop(): Promise<void> {
    this.running = false;
  }
}

export interface RedisQueueOptions {
  redisUrl: string;
  queueKey?: string;
  popTimeoutSeconds?: number;
  client?: Redis;
  workerClient?: Redis;
}

/**
 * Redis-backed asynchronous ingestion queue.
 *
 * Uses Redis RPUSH / BLPOP on a list key (`poste:queue:letters`).
 * Decouples high-volume letter intake (e.g. SMTP batches or bulk imports)
 * from archive storage, embedding generation, and semantic indexing.
 */
export class RedisIngestionQueue implements IngestionQueue {
  private readonly queueKey: string;
  private readonly popTimeout: number;
  private readonly producer: Redis;
  private readonly consumer: Redis;
  private running = false;
  private loopPromise: Promise<void> | null = null;

  constructor(
    options: RedisQueueOptions,
    private readonly ingest: IngestHandler,
    private readonly log?: Logger,
  ) {
    this.queueKey = options.queueKey ?? "poste:queue:letters";
    this.popTimeout = options.popTimeoutSeconds ?? 2;
    this.producer = options.client ?? new Redis(options.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
    this.consumer = options.workerClient ?? new Redis(options.redisUrl, { lazyConnect: true, maxRetriesPerRequest: 2 });
  }

  get isRunning(): boolean {
    return this.running;
  }

  async enqueue(letter: Letter): Promise<void> {
    const payload = JSON.stringify(letter);
    await this.producer.rpush(this.queueKey, payload);
    this.log?.info("queue:enqueued", {
      thread: letter.envelope.thread,
      kind: letter.envelope.kind,
    });
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.loopPromise = this.consumerLoop();
    this.log?.info("queue:started", { queueKey: this.queueKey });
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    try {
      await this.consumer.disconnect();
      await this.producer.disconnect();
    } catch {
      // Clean shutdown
    }
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
    this.log?.info("queue:stopped", { queueKey: this.queueKey });
  }

  private async consumerLoop(): Promise<void> {
    while (this.running) {
      try {
        const item = await this.consumer.blpop(this.queueKey, this.popTimeout);
        if (!item || !this.running) continue;

        const [, letterJson] = item;
        try {
          const letter: Letter = JSON.parse(letterJson);
          await this.ingest(letter);
        } catch (err) {
          this.log?.error("queue:process-failed", {
            error: err instanceof Error ? err.message : String(err),
          });
        }
      } catch (err) {
        if (!this.running) break;
        this.log?.error("queue:blpop-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
        // Backoff slightly on connection error
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
}

/**
 * Create an ingestion queue based on configuration.
 * Returns RedisIngestionQueue when redisUrl is set, DirectIngestionQueue otherwise.
 */
export function createIngestionQueue(
  redisUrl: string | undefined,
  ingest: IngestHandler,
  log?: Logger,
): IngestionQueue {
  if (redisUrl) {
    return new RedisIngestionQueue({ redisUrl }, ingest, log);
  }
  return new DirectIngestionQueue(ingest, log);
}
