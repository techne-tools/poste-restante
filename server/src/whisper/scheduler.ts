/**
 * The scheduled gap pass — the house breathes.
 *
 * detectGaps is on-demand only (HTTP /v1/whisper/gaps, MCP detect_gaps):
 * nothing runs unless a caller asks, so the whisper is only ever as fresh
 * as the last manual run. The scheduler is the engine's heartbeat — a
 * config-gated interval that runs the existing detector for every resident
 * (an address with a credential). It only *stores* whispers; the resident
 * still pulls the GET, so presence-not-pressure holds. The house breathes,
 * it never interrupts.
 *
 * Privacy: scoped per address, exactly like the on-demand path — only
 * residents with a credential are enumerated, and detectGaps never scans
 * correspondence the address is not party to. Logs carry event names and
 * counts only, never bodies, addresses, or thread ids.
 */

import type { Logger } from "../pipeline/logger.js";

export interface GapSchedulerDeps {
  /** Enumerate the residents the scheduler may run detection for. */
  listResidents(): Promise<{ address: string }[]>;
  /** Run one detection pass for one address. */
  detectGaps(address: string): Promise<unknown[]>;
  log?: Logger;
}

/**
 * Start the scheduled gap pass for a live house. Residents are the house's
 * credentials (an address with a credential can act — the human or agent
 * the house holds for). Returns null when the interval is disabled (0).
 */
export function startGapScheduler(
  house: {
    whisper: { detectGaps(address: string): Promise<unknown[]> };
    log: Logger;
  },
  auth: { listCredentials(): Promise<{ address: string }[]> },
  intervalMs: number,
): GapScheduler | null {
  if (intervalMs <= 0) return null;
  const scheduler = new GapScheduler(
    {
      listResidents: async () => (await auth.listCredentials()).map((c) => ({ address: c.address })),
      detectGaps: (address) => house.whisper.detectGaps(address),
      log: house.log,
    },
    intervalMs,
  );
  scheduler.start();
  house.log.info("gap:scheduler", { intervalMs });
  return scheduler;
}

export class GapScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly deps: GapSchedulerDeps;

  constructor(deps: GapSchedulerDeps, intervalMs: number) {
    this.deps = deps;
    this.intervalMs = intervalMs;
  }

  /** Start the heartbeat. Calling more than once is a no-op. */
  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.runPass();
    }, this.intervalMs);
    // The interval itself must never hold the process open after close().
    if (typeof this.timer.unref === "function") this.timer.unref();
  }

  /** Stop the heartbeat. Subsequent start() resumes. */
  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /**
   * Run one detection pass over every resident. Overlap-safe: if a pass is
   * already running (a previous interval tick is still detecting), this
   * returns without touching the detector. Errors per address are caught
   * and logged — one resident's failure must not stop the house for the
   * others. Returns the total number of residents scanned.
   */
  async runPass(): Promise<number> {
    if (this.running) {
      this.deps.log?.warn("gap:pass-skipped", { reason: "overlap" });
      return 0;
    }
    this.running = true;
    try {
      const residents = await this.deps.listResidents();
      for (const resident of residents) {
        try {
          const created = await this.deps.detectGaps(resident.address);
          this.deps.log?.info("gap:pass", {
            resident: "<redacted>",
            created: created.length,
          });
        } catch (err) {
          this.deps.log?.warn("gap:pass-error", {
            resident: "<redacted>",
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      return residents.length;
    } finally {
      this.running = false;
    }
  }
}
