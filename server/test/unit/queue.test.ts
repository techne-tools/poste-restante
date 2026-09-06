import { describe, it, expect, vi } from "vitest";
import {
  DirectIngestionQueue,
  RedisIngestionQueue,
  createIngestionQueue,
} from "../../src/queue/queue.js";
import type { Letter } from "../../src/types.js";
import type { Redis } from "ioredis";

function sampleLetter(): Letter {
  return {
    envelope: {
      from: "alice@house",
      to: ["bob@house"],
      cc: [],
      thread: "th_test1",
      kind: "letter",
      lang: "en-AU",
      subject: "test subject",
    },
    time: {
      gregorian: "2026-09-06T12:00:00Z",
      frames: [{ frame: "season", value: "spring" }],
    },
    body: {
      format: "markdown",
      content: "Hello from the queue!",
    },
  };
}

describe("DirectIngestionQueue", () => {
  it("ingests synchronously on enqueue", async () => {
    const ingest = vi.fn().mockResolvedValue({ letterId: "let_123", created: true });
    const queue = new DirectIngestionQueue(ingest);

    const letter = sampleLetter();
    await queue.enqueue(letter);

    expect(ingest).toHaveBeenCalledTimes(1);
    expect(ingest).toHaveBeenCalledWith(letter);
  });

  it("throws if enqueue called when stopped", async () => {
    const ingest = vi.fn();
    const queue = new DirectIngestionQueue(ingest);
    await queue.stop();

    await expect(queue.enqueue(sampleLetter())).rejects.toThrow("Ingestion queue is stopped");
  });
});

describe("RedisIngestionQueue", () => {
  it("enqueues letters via RPUSH and processes via BLPOP", async () => {
    const letter = sampleLetter();
    const ingest = vi.fn().mockResolvedValue({ letterId: "let_abc", created: true });

    let queueItem: string | null = JSON.stringify(letter);
    const mockProducer = {
      rpush: vi.fn().mockResolvedValue(1),
      disconnect: vi.fn(),
    } as unknown as Redis;

    const mockConsumer = {
      blpop: vi.fn().mockImplementation(async () => {
        if (queueItem) {
          const item = queueItem;
          queueItem = null;
          return ["poste:queue:letters", item];
        }
        await new Promise((r) => setTimeout(r, 10));
        return null;
      }),
      disconnect: vi.fn(),
    } as unknown as Redis;

    const queue = new RedisIngestionQueue(
      {
        redisUrl: "redis://localhost:6379",
        client: mockProducer,
        workerClient: mockConsumer,
        popTimeoutSeconds: 1,
      },
      ingest,
    );

    await queue.enqueue(letter);
    expect(mockProducer.rpush).toHaveBeenCalledWith(
      "poste:queue:letters",
      JSON.stringify(letter),
    );

    await queue.start();
    // Allow consumer loop to run
    await new Promise((r) => setTimeout(r, 50));
    expect(ingest).toHaveBeenCalledWith(letter);

    await queue.stop();
    expect(queue.isRunning).toBe(false);
  });

  it("createIngestionQueue selects implementation based on redisUrl", () => {
    const ingest = vi.fn();
    const direct = createIngestionQueue(undefined, ingest);
    expect(direct).toBeInstanceOf(DirectIngestionQueue);

    const redis = createIngestionQueue("redis://localhost:6379", ingest);
    expect(redis).toBeInstanceOf(RedisIngestionQueue);
    void redis.stop();
  });
});
