/**
 * The agent death sweep — tasks die (SPEC §16, "no zombies").
 *
 * The sweep itself (sweepExpired) is the machinery; this scheduler is the
 * heartbeat that runs it. An agent whose lifespan frame has been quiet for
 * the activity window writes its final letter and stops waking. The house
 * breathes exactly like the gap pass: a config-gated interval
 * (AGENT_SWEEP_INTERVAL_MS), overlap-guarded, restart-safe — a missed
 * tick self-heals on the next one.
 *
 * Privacy: the sweep touches only the agents' own rows and the frames
 * they were born into; the final letter is addressed to the creator (a
 * participant edge, visible only inside that correspondence). Logs carry
 * event names and counts, never bodies, addresses, or thread ids.
 */

import type { Logger } from "../pipeline/logger.js";

export interface AgentSweepDeps {
  sweepExpired(now?: Date, activityWindowMs?: number): Promise<string[]>;
  log?: Logger;
}

export class AgentSweepScheduler {
  private timer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private readonly intervalMs: number;
  private readonly deps: AgentSweepDeps;

  constructor(deps: AgentSweepDeps, intervalMs: number) {
    this.deps = deps;
    this.intervalMs = intervalMs;
  }

  start(): void {
    if (this.timer || this.intervalMs <= 0) return;
    // An immediate first pass — restart-safe: if a sweep was missed while
    // the house was down, the next boot catches it. The timer then ticks
    // on the rhythm.
    void this.runSweep();
    this.timer = setInterval(() => void this.runSweep(), this.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  /** Run one sweep. Returns the number of agents killed. Overlap-guarded. */
  async runSweep(): Promise<number> {
    if (this.running) return 0;
    this.running = true;
    try {
      const killed = await this.deps.sweepExpired();
      if (killed.length > 0) {
        this.deps.log?.info("agent:sweep-tick", { killed: killed.length });
      }
      return killed.length;
    } catch (err) {
      this.deps.log?.error("agent:sweep-failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return 0;
    } finally {
      this.running = false;
    }
  }
}

/** Start the scheduled agent death sweep for a live house. Returns null
 *  when the interval is disabled (0). */
export function startAgentSweepScheduler(
  house: { agents: { sweepExpired(now?: Date, windowMs?: number): Promise<string[]> }; log: Logger },
  intervalMs: number,
): AgentSweepScheduler | null {
  if (intervalMs <= 0) return null;
  const scheduler = new AgentSweepScheduler(
    { sweepExpired: (now, window) => house.agents.sweepExpired(now, window), log: house.log },
    intervalMs,
  );
  scheduler.start();
  house.log.info("agent:sweep-scheduler", { intervalMs });
  return scheduler;
}
