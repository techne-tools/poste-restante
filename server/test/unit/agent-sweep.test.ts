/**
 * The agent death sweep scheduler — tasks die (SPEC §16).
 *
 * The scheduler is the heartbeat running sweepExpired on its own rhythm.
 * These tests pin the mechanics: what runs, what happens on overlap, and
 * how the timer is owned — the mirror of the gap scheduler's tests.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  AgentSweepScheduler,
  startAgentSweepScheduler,
} from "../../src/agents/scheduler.js";

const info = vi.fn<(event: string, fields?: Record<string, unknown>) => void>();
const error = vi.fn<(event: string, fields?: Record<string, unknown>) => void>();

function deps(over: { sweepExpired?: () => Promise<string[]> } = {}) {
  return {
    sweepExpired: vi.fn(async (): Promise<string[]> => ["grantwatch@house"]),
    log: { info, error } as unknown as import("../../src/pipeline/logger.js").Logger,
    ...over,
  };
}

describe("AgentSweepScheduler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("runs the sweep once and reports the killed count", async () => {
    const d = deps();
    const scheduler = new AgentSweepScheduler(d, 60_000);
    const killed = await scheduler.runSweep();
    expect(killed).toBe(1);
    expect(d.sweepExpired).toHaveBeenCalledTimes(1);
    expect(info).toHaveBeenCalledWith("agent:sweep-tick", { killed: 1 });
  });

  it("skips an overlapping sweep — no double-kill in one rhythm", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => (release = () => resolve()));
    const d = deps({
      sweepExpired: vi.fn(async (): Promise<string[]> => {
        await gate;
        return [];
      }),
    });
    const scheduler = new AgentSweepScheduler(d, 60_000);
    const first = scheduler.runSweep(); // in flight
    const second = await scheduler.runSweep(); // overlap → skip
    expect(second).toBe(0);
    release();
    await first;
    expect(d.sweepExpired).toHaveBeenCalledTimes(1);
  });

  it("isolates a sweep failure — the house keeps breathing, the next tick retries", async () => {
    const d = deps({
      sweepExpired: vi.fn(async (): Promise<string[]> => {
        throw new Error("sweep unreachable");
      }),
    });
    const scheduler = new AgentSweepScheduler(d, 60_000);
    const killed = await scheduler.runSweep();
    expect(killed).toBe(0);
    expect(error).toHaveBeenCalledWith("agent:sweep-failed", expect.objectContaining({}));
  });

  it("start() schedules a tick and stop() clears it", () => {
    vi.useFakeTimers();
    const scheduler = new AgentSweepScheduler(deps(), 60_000);
    scheduler.start();
    expect(scheduler["timer"]).not.toBeNull();
    scheduler.stop();
    expect(scheduler["timer"]).toBeNull();
  });

  it("start() is idempotent — a second start does not double-schedule", () => {
    vi.useFakeTimers();
    const scheduler = new AgentSweepScheduler(deps(), 60_000);
    scheduler.start();
    const first = scheduler["timer"];
    scheduler.start();
    expect(scheduler["timer"]).toBe(first);
    scheduler.stop();
  });

  it("startAgentSweepScheduler returns null when the interval is disabled", () => {
    const scheduler = startAgentSweepScheduler(
      { agents: { sweepExpired: async () => [] }, log: { info, error } } as never,
      0,
    );
    expect(scheduler).toBeNull();
  });
});
