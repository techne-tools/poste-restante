/**
 * The scheduled gap pass — the house breathes.
 *
 * The scheduler is the engine's heartbeat: an interval that runs the
 * existing detector per resident. Presence not pressure — it only STORES
 * whispers; the resident still pulls the GET. These tests pin the
 * mechanics: who is enumerated, what happens on overlap, what happens when
 * one resident's pass throws, and how the timer is owned.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { GapScheduler, startGapScheduler } from "../../src/whisper/scheduler.js";

const info = vi.fn<(event: string, fields?: Record<string, unknown>) => void>();
const warn = vi.fn<(event: string, fields?: Record<string, unknown>) => void>();

function deps(
  over: {
    listResidents?: () => Promise<{ address: string }[]>;
    detectGaps?: (address: string) => Promise<unknown[]>;
  } = {},
) {
  return {
    listResidents: vi.fn(async () => [{ address: "you@house" }, { address: "hermes@house" }]),
    detectGaps: vi.fn(async (): Promise<unknown[]> => [{}]),
    log: { info, warn } as unknown as import("../../src/pipeline/logger.js").Logger,
    ...over,
  };
}

describe("GapScheduler", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("runs detectGaps for every resident in one pass", async () => {
    const d = deps();
    const scheduler = new GapScheduler(d, 60_000);
    const scanned = await scheduler.runPass();
    expect(scanned).toBe(2);
    expect(d.listResidents).toHaveBeenCalledTimes(1);
    expect(d.detectGaps).toHaveBeenCalledTimes(2);
    expect(d.detectGaps).toHaveBeenCalledWith("you@house");
    expect(d.detectGaps).toHaveBeenCalledWith("hermes@house");
  });

  it("skips the pass when a previous pass is still running", async () => {
    let releaseAll: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseAll = () => resolve()));
    const d = deps({
      detectGaps: vi.fn(async (): Promise<unknown[]> => {
        await gate;
        return [{}];
      }),
    });
    const scheduler = new GapScheduler(d, 60_000);
    const first = scheduler.runPass(); // in flight — both residents await the gate
    const second = await scheduler.runPass(); // overlap → skip
    expect(second).toBe(0);
    expect(warn).toHaveBeenCalledWith("gap:pass-skipped", { reason: "overlap" });
    releaseAll();
    await first;
    expect(d.detectGaps).toHaveBeenCalledTimes(2); // the first pass still completes
  });

  it("isolates one resident's failure — the pass continues for the others", async () => {
    const d = deps({
      detectGaps: vi.fn(async (address: string) => {
        if (address === "you@house") throw new Error("semantic layer unreachable");
        return [{}];
      }),
    });
    const scheduler = new GapScheduler(d, 60_000);
    const scanned = await scheduler.runPass();
    expect(scanned).toBe(2);
    expect(d.detectGaps).toHaveBeenCalledTimes(2); // the house keeps breathing
    expect(warn).toHaveBeenCalledWith("gap:pass-error", expect.objectContaining({ resident: "<redacted>" }));
  });

  it("start() schedules a tick and stop() clears it", async () => {
    vi.useFakeTimers();
    const scheduler = new GapScheduler(deps(), 60_000);
    scheduler.start();
    expect(scheduler["timer"]).not.toBeNull();
    scheduler.stop();
    expect(scheduler["timer"]).toBeNull();
  });

  it("start() is idempotent — a second start does not double-schedule", async () => {
    vi.useFakeTimers();
    const scheduler = new GapScheduler(deps(), 60_000);
    scheduler.start();
    const first = scheduler["timer"];
    scheduler.start();
    expect(scheduler["timer"]).toBe(first);
    scheduler.stop();
  });

  it("startGapScheduler returns null when the interval is disabled", () => {
    const scheduler = startGapScheduler(
      { whisper: { detectGaps: async () => [] }, log: { info, warn } } as never,
      { listCredentials: async () => [] } as never,
      0,
    );
    expect(scheduler).toBeNull();
  });
});
