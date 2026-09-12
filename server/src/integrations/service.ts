/**
 * IntegrationService — external tool integration for agents (SPEC §17,
 * direction B: house → external MCP server).
 *
 * Correspondence is the floor; integrations are grants — never defaults,
 * never self-granted. An agent calls external tools *through* the house.
 *
 * The one boundary that makes B safe: external tools extend what an
 * agent can *know* and *compute* — never what it can *write*. An
 * integration's response returns to the agent; the only way anything
 * enters the archive is the house's own deliver tool, which enforces the
 * three doors (§16). No integration touches the archive, mints letters or
 * addresses, or pushes — results return synchronously; the house relays,
 * it never interrupts.
 *
 * Registered, not discovered: the house proxies only *registered*
 * integrations (address ↔ URL ↔ pinned version). SSRF dead by
 * construction — the house never fetches an agent-provided URL.
 *
 * Every call is an audit letter: one letter per toolcall — event id,
 * tool, timestamp — addressed to the creator and the agent itself, never
 * the pub. The args are ephemeral: passed to the server, never stored.
 */
import { randomBytes } from "node:crypto";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type pg from "pg";
import type { Logger } from "../pipeline/logger.js";
import type { IngestionPipeline } from "../pipeline/pipeline.js";
import type { Letter } from "../types.js";

/** The one boundary an integration call crosses — injected so the unit
 *  tests can fake the wire. The production shape connects the MCP SDK
 *  client to the operator-registered URL over stdio (v1 remote-only),
 *  calls the whitelisted tool with a hard timeout, and closes cleanly. */
export interface IntegrationTransport {
  callTool(
    params: { name: string; arguments?: Record<string, unknown> },
    options?: { timeout?: number },
  ): Promise<unknown>;
  close(): Promise<void>;
}

export interface IntegrationServiceOptions {
  /** Hard timeout per toolcall, ms. Default 15_000. */
  timeoutMs?: number;
  /** Rate limit: max calls per (agent, integration) per window. Default
   *  30 calls / 60 s. In-memory — the house holds, it never floods. */
  rateMax?: number;
  rateWindowMs?: number;
  /** Injectable call boundary for tests (defaults to the MCP client
   *  over stdio — npx -y <url>). */
  transportFactory?: (
    url: string,
  ) => Promise<IntegrationTransport> | IntegrationTransport;
}

/** A registered integration — the operator's catalog. */
export interface Integration {
  id: string;
  url: string;
  version: string;
  tools: { name: string; description: string; verbs: string[] }[];
  enabled: boolean;
}

/** The per-agent whitelist — the instrument's constitution. */
export interface AgentIntegration {
  agentAddress: string;
  integrationId: string;
  tools: string[];
  frameBudget: number;
}

export class IntegrationService {
  private readonly timeoutMs: number;
  private readonly rateMax: number;
  private readonly rateWindowMs: number;
  private readonly transportFactory?: IntegrationServiceOptions["transportFactory"];
  /** In-memory sliding window per (agent, integration) — the house holds,
   *  it never floods. */
  private readonly calls: Map<string, number[]> = new Map();

  constructor(
    private readonly pool: pg.Pool,
    private readonly pipeline: IngestionPipeline,
    private readonly log: Logger,
    options: IntegrationServiceOptions = {},
  ) {
    this.timeoutMs = options.timeoutMs ?? 15_000;
    this.rateMax = options.rateMax ?? 30;
    this.rateWindowMs = options.rateWindowMs ?? 60_000;
    this.transportFactory = options.transportFactory;
    // Bound the in-memory rate map — a dead agent's history is forgotten
    // with the house's own breath, never leaking across restarts.
    setInterval(() => this.sweepRateMap(), Math.max(this.rateWindowMs, 60_000)).unref?.();
  }

  private sweepRateMap(): void {
    const now = Date.now();
    for (const [key, stamps] of this.calls) {
      const live = stamps.filter((t) => now - t < this.rateWindowMs);
      if (live.length === 0) this.calls.delete(key);
      else this.calls.set(key, live);
    }
  }

  private rateLimited(agentAddress: string, integrationId: string): boolean {
    const key = `${agentAddress}\u0000${integrationId}`;
    const now = Date.now();
    const live = (this.calls.get(key) ?? []).filter((t) => now - t < this.rateWindowMs);
    this.calls.set(key, live);
    if (live.length >= this.rateMax) return true;
    live.push(now);
    return false;
  }

  /** Register an integration — an operator act, like installing a sidecar. */
  async register(
    id: string,
    url: string,
    version: string,
    tools: { name: string; description: string; verbs: string[] }[],
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO integrations (id, url, version, tools, enabled)
       VALUES ($1, $2, $3, $4, true)
       ON CONFLICT (id) DO UPDATE
         SET url = $2, version = $3, tools = $4, enabled = true`,
      [id, url, version, JSON.stringify(tools)],
    );
    this.log.info("integration:registered", { id, version });
  }

  /** Whitelist tools for an agent — the creator's grant, per scope. */
  async grant(agentAddress: string, integrationId: string, tools: string[], frameBudget = 100): Promise<void> {
    await this.pool.query(
      `INSERT INTO agent_integrations (agent_address, integration_id, tools, frame_budget)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (agent_address, integration_id) DO UPDATE
         SET tools = $3, frame_budget = $4`,
      [agentAddress, integrationId, tools, frameBudget],
    );
    this.log.info("integration:granted", { agentAddress, integrationId, tools: tools.length });
  }

  /** The tools an agent may call on an integration — enumerated, not discoverable. */
  async allowedTools(agentAddress: string, integrationId: string): Promise<string[] | null> {
    const { rows } = await this.pool.query<{ tools: string[] }>(
      `SELECT tools FROM agent_integrations
       WHERE agent_address = $1 AND integration_id = $2`,
      [agentAddress, integrationId],
    );
    return rows[0]?.tools ?? null;
  }

  /** The integration's catalog — what the operator registered. */
  async getIntegration(id: string): Promise<Integration | null> {
    const { rows } = await this.pool.query<{
      id: string;
      url: string;
      version: string;
      tools: { name: string; description: string; verbs: string[] }[];
      enabled: boolean;
    }>(`SELECT id, url, version, tools, enabled FROM integrations WHERE id = $1`, [id]);
    const row = rows[0];
    if (!row) return null;
    return { ...row, tools: row.tools ?? [] };
  }

  /**
   * Call a tool on a registered integration, through the house. The
   * response returns to the agent synchronously; the house relays, it
   * never interrupts. Every call is an audit letter — event id, tool,
   * timestamp — addressed to the creator and the agent, never the pub.
   *
   * Bounded by construction: a hard timeout on every toolcall, an
   * in-memory rate window per (agent, integration), and the per-frame
   * budget (frame_budget) decremented atomically — when it hits zero,
   * the instrument is silent until its creator re-grants. The house
   * holds; it never floods.
   */
  async call(
    agentAddress: string,
    integrationId: string,
    tool: string,
    args: Record<string, unknown>,
  ): Promise<{ ok: boolean; result?: unknown; error?: string; eventId: string }> {
    if (this.rateLimited(agentAddress, integrationId)) {
      const eventId = `evt_${randomBytes(8).toString("hex")}`;
      await this.audit(agentAddress, integrationId, tool, eventId, { error: "rate limited" });
      return { ok: false, error: "rate limited — the house asks you to wait", eventId };
    }

    const integration = await this.getIntegration(integrationId);
    if (!integration || !integration.enabled) {
      const eventId = `evt_${randomBytes(8).toString("hex")}`;
      await this.audit(agentAddress, integrationId, tool, eventId, { error: "no such integration" });
      return { ok: false, error: "no such integration", eventId };
    }
    const allowed = await this.allowedTools(agentAddress, integrationId);
    if (!allowed || !allowed.includes(tool)) {
      const eventId = `evt_${randomBytes(8).toString("hex")}`;
      await this.audit(agentAddress, integrationId, tool, eventId, { error: "tool not granted" });
      return { ok: false, error: "tool not granted to this instrument", eventId };
    }

    // The per-frame budget — decremented atomically. When it hits zero,
    // the instrument is silent until its creator re-grants. The budget
    // is per (agent, integration) row; the frame is the agent's current
    // plural-time frame, held in the same column (v1: the frame boundary
    // is the grant itself — re-granting resets the count).
    const budget = await this.spendBudget(agentAddress, integrationId);
    if (budget === null) {
      const eventId = `evt_${randomBytes(8).toString("hex")}`;
      await this.audit(agentAddress, integrationId, tool, eventId, { error: "budget exhausted" });
      return { ok: false, error: "this instrument's frame budget is spent — ask your creator", eventId };
    }

    const eventId = `evt_${randomBytes(8).toString("hex")}`;
    try {
      // v1 remote-only: the house connects to the operator-registered URL
      // over stdio (the MCP client). The house never runs integration
      // code in-process. The transport factory is injectable so unit
      // tests never spawn a process.
      const factory =
        this.transportFactory ??
        (async (url: string): Promise<IntegrationTransport> => {
          const transport = new StdioClientTransport({
            command: "npx",
            args: ["-y", url],
          });
          const client = new Client({ name: "poste-restante", version: "0.1.0" });
          await client.connect(transport);
          return {
            callTool: (params, options) =>
              client.callTool(params, undefined, options) as Promise<unknown>,
            close: async () => {
              await client.close();
            },
          };
        });
      const tr = await factory(integration.url);
      const result = await tr.callTool({ name: tool, arguments: args }, { timeout: this.timeoutMs });
      await tr.close().catch(() => {});

      await this.audit(agentAddress, integrationId, tool, eventId, result);
      return { ok: true, result, eventId };
    } catch (err) {
      this.log.error("integration:call-failed", {
        agentAddress,
        integrationId,
        tool,
        eventId,
        error: err instanceof Error ? err.message : String(err),
      });
      return { ok: false, error: err instanceof Error ? err.message : String(err), eventId };
    }
  }

  /** Spend one call from the agent's frame budget, atomically. Returns
   *  the remaining budget, or null when the budget is exhausted (or the
   *  agent has no grant at all). */
  private async spendBudget(
    agentAddress: string,
    integrationId: string,
  ): Promise<number | null> {
    const res = await this.pool.query<{ remaining: number }>(
      `UPDATE agent_integrations
       SET frame_budget = frame_budget - 1
       WHERE agent_address = $1 AND integration_id = $2
         AND frame_budget > 0
       RETURNING frame_budget`,
      [agentAddress, integrationId],
    );
    const row = res.rows[0];
    return row ? row.remaining : null;
  }

  /** The audit letter — transparency as regulation. The creator sees what
   *  their instrument did; no one else can. */
  private async audit(
    agentAddress: string,
    integrationId: string,
    tool: string,
    eventId: string,
    result: unknown,
  ): Promise<void> {
    const { rows } = await this.pool.query<{ creator: string }>(
      `SELECT creator FROM agents WHERE address = $1`,
      [agentAddress],
    );
    const creator = rows[0]?.creator;
    if (!creator) return;

    const letter: Letter = {
      envelope: {
        from: agentAddress,
        to: [creator, agentAddress],
        cc: [],
        thread: `th_audit_${eventId}`,
        kind: "letter",
        lang: "en-AU",
        subject: `integration call: ${integrationId}.${tool}`,
      },
      time: { gregorian: new Date().toISOString(), frames: [] },
      body: {
        format: "markdown",
        content: `Integration call \`${integrationId}.${tool}\` (${eventId}).\n\nResult: ${JSON.stringify(result).slice(0, 500)}`,
      },
    };
    await this.pipeline.ingest(letter).catch((err) => {
      this.log.error("integration:audit-failed", {
        eventId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }
}
