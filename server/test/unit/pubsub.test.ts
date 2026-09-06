import { describe, it, expect, vi } from "vitest";
import {
  MemoryHouseEventBus,
  RedisHouseEventBus,
  createHouseEventBus,
  type HouseEvent,
} from "../../src/queue/pubsub.js";
import type { Redis } from "ioredis";

describe("MemoryHouseEventBus", () => {
  it("publishes and subscribes to house events", async () => {
    const bus = new MemoryHouseEventBus();
    const received: HouseEvent[] = [];

    const unsubscribe = bus.subscribe((evt) => {
      received.push(evt);
    });

    const event: HouseEvent = {
      type: "letter:stored",
      letterId: "let_456",
      thread: "th_test",
      kind: "letter",
    };

    await bus.publish(event);
    expect(received).toEqual([event]);

    unsubscribe();
    await bus.publish({ ...event, letterId: "let_789" });
    expect(received.length).toBe(1);

    await bus.close();
  });
});

describe("RedisHouseEventBus", () => {
  it("publishes JSON and dispatches message events", async () => {
    let messageListener: ((chan: string, msg: string) => void) | null = null;

    const mockPub = {
      publish: vi.fn().mockResolvedValue(1),
      disconnect: vi.fn(),
    } as unknown as Redis;

    const mockSub = {
      subscribe: vi.fn().mockResolvedValue("OK"),
      on: vi.fn().mockImplementation((event, handler) => {
        if (event === "message") {
          messageListener = handler;
        }
      }),
      disconnect: vi.fn(),
    } as unknown as Redis;

    const bus = new RedisHouseEventBus(
      "redis://localhost:6379",
      "house:events",
      undefined,
      mockPub,
      mockSub,
    );

    const received: HouseEvent[] = [];
    bus.subscribe((evt) => {
      received.push(evt);
    });

    const event: HouseEvent = {
      type: "whisper:updated",
      address: "alice@house",
    };

    await bus.publish(event);
    expect(mockPub.publish).toHaveBeenCalledWith("house:events", JSON.stringify(event));

    // Simulate incoming message
    if (messageListener) {
      (messageListener as (chan: string, msg: string) => void)("house:events", JSON.stringify(event));
    }
    expect(received).toEqual([event]);

    await bus.close();
  });

  it("createHouseEventBus selects implementation based on redisUrl", async () => {
    const memBus = createHouseEventBus(undefined);
    expect(memBus).toBeInstanceOf(MemoryHouseEventBus);

    const redisBus = createHouseEventBus("redis://localhost:6379");
    expect(redisBus).toBeInstanceOf(RedisHouseEventBus);
    await redisBus.close();
  });
});
