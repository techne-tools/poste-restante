import { EventEmitter } from "node:events";
import { Redis } from "ioredis";
import type { Logger } from "../pipeline/logger.js";

export type HouseEvent =
  | { type: "letter:stored"; letterId: string; thread: string; kind: string }
  | { type: "whisper:updated"; address: string }
  | { type: "book:ratified"; threadId: string };

export type EventHandler = (event: HouseEvent) => void | Promise<void>;

/**
 * Event bus for pub/sub across the house.
 *
 * Ephemeral state / pub/sub layer (SPEC §3.1).
 * Used by whisper and other house residents to listen for incoming mail and updates.
 */
export interface HouseEventBus {
  publish(event: HouseEvent): Promise<void>;
  subscribe(handler: EventHandler): () => void;
  close(): Promise<void>;
}

/**
 * In-memory event bus (Node.js EventEmitter).
 * Used when REDIS_URL is unset.
 */
export class MemoryHouseEventBus implements HouseEventBus {
  private readonly emitter = new EventEmitter();
  private readonly eventName = "house:event";

  async publish(event: HouseEvent): Promise<void> {
    this.emitter.emit(this.eventName, event);
  }

  subscribe(handler: EventHandler): () => void {
    const wrapped = (event: HouseEvent) => {
      void Promise.resolve(handler(event)).catch(() => {});
    };
    this.emitter.on(this.eventName, wrapped);
    return () => {
      this.emitter.off(this.eventName, wrapped);
    };
  }

  async close(): Promise<void> {
    this.emitter.removeAllListeners();
  }
}

/**
 * Redis pub/sub event bus.
 * Multi-process/container communication on the host.
 */
export class RedisHouseEventBus implements HouseEventBus {
  private readonly pub: Redis;
  private readonly sub: Redis;
  private readonly channel: string;
  private readonly handlers = new Set<EventHandler>();
  private isListening = false;

  constructor(
    redisUrl: string,
    channel = "house:events",
    private readonly log?: Logger,
    client?: Redis,
    subClient?: Redis,
  ) {
    this.channel = channel;
    this.pub = client ?? new Redis(redisUrl, { lazyConnect: true });
    this.sub = subClient ?? new Redis(redisUrl, { lazyConnect: true });
  }

  async publish(event: HouseEvent): Promise<void> {
    try {
      await this.pub.publish(this.channel, JSON.stringify(event));
    } catch (err) {
      this.log?.error("pubsub:publish-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  subscribe(handler: EventHandler): () => void {
    this.handlers.add(handler);
    if (!this.isListening) {
      this.isListening = true;
      this.sub.subscribe(this.channel).catch((err) => {
        this.log?.error("pubsub:subscribe-failed", {
          error: err instanceof Error ? err.message : String(err),
        });
      });
      this.sub.on("message", (chan, message) => {
        if (chan !== this.channel) return;
        try {
          const event: HouseEvent = JSON.parse(message);
          for (const h of this.handlers) {
            void Promise.resolve(h(event)).catch(() => {});
          }
        } catch {
          // Ignore parse errors
        }
      });
    }

    return () => {
      this.handlers.delete(handler);
    };
  }

  async close(): Promise<void> {
    this.handlers.clear();
    try {
      await this.sub.disconnect();
      await this.pub.disconnect();
    } catch {
      // Clean disconnect
    }
  }
}

export function createHouseEventBus(
  redisUrl: string | undefined,
  log?: Logger,
): HouseEventBus {
  if (redisUrl) {
    return new RedisHouseEventBus(redisUrl, "house:events", log);
  }
  return new MemoryHouseEventBus();
}
