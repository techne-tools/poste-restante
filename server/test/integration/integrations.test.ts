/**
 * External tool integrations — SPEC §17, direction B, integration tests.
 *
 * These prove the seam against live infra (postgres 15, qdrant, ollama).
 * Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   register → the operator's catalog
 *   grant    → the per-agent whitelist
 *   call     → whitelist enforced; every call is an audit letter
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import { AgentService } from "../../src/agents/service.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("integrations (integration)", () => {
  let house: House;
  let auth: AuthService;
  let app: ReturnType<typeof createLetterServer>;

  beforeAll(async () => {
    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
      AUTH_MODE: "basic",
    });
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    await house.db.pool.query(
      `TRUNCATE invites, whispers, clauses, clause_objectors, clause_vouchers,
              thread_participation, letters, threads, frames, addresses, credentials,
              address_keys, agents, integrations, agent_integrations
       RESTART IDENTITY CASCADE`,
    );
    await house.db.pool.query(
      `INSERT INTO addresses (id, is_public) VALUES ('book@house', false), ('pub@house', true)`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth, house.whisper);
    await auth.setPassword("you@house", "youyouyou");
    app = createLetterServer(house, { auth });
  });

  afterAll(async () => {
    await house.close();
  });

  it("registers an integration — the operator's catalog", async () => {
    await house.integrations.register(
      "web-search",
      "https://search.example.com/mcp",
      "1.2.3",
      [
        { name: "search", description: "search the web", verbs: ["read"] },
        { name: "extract", description: "extract a page", verbs: ["read"] },
      ],
    );
    const integration = await house.integrations.getIntegration("web-search");
    expect(integration).not.toBeNull();
    expect(integration!.url).toBe("https://search.example.com/mcp");
    expect(integration!.version).toBe("1.2.3");
    expect(integration!.tools.map((t) => t.name)).toEqual(["search", "extract"]);
  });

  it("grants tools per agent — the instrument's constitution", async () => {
    // Mint an agent.
    const birth = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        envelope: {
          from: "you@house",
          to: [AgentService.AGENTS_ADDRESS],
          cc: [],
          thread: "th_agent_birth3",
          kind: "agent",
          lang: "en-AU",
          subject: "grantwatch",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: "track calls for international arts grants" },
      }),
    });
    expect(birth.status).toBe(201);
    const { rows } = await house.db.pool.query<{ address: string }>(
      `SELECT address FROM agents WHERE task LIKE 'track calls%'`,
    );
    const agent = rows[0].address;

    // Grant only 'search' — not 'extract'.
    await house.integrations.grant(agent, "web-search", ["search"]);
    expect(await house.integrations.allowedTools(agent, "web-search")).toEqual(["search"]);
  });

  it("enforces the whitelist — a non-granted tool is refused", async () => {
    const { rows } = await house.db.pool.query<{ address: string }>(
      `SELECT address FROM agents WHERE task LIKE 'track calls%'`,
    );
    const agent = rows[0].address;

    // 'extract' is in the catalog but not granted — the call is refused
    // before any transport happens.
    const res = await house.integrations.call(agent, "web-search", "extract", { url: "https://x" });
    expect(res.ok).toBe(false);
    expect(res.error).toContain("not granted");
  });

  it("every call is an audit letter — addressed to the creator and the agent", async () => {
    const { rows } = await house.db.pool.query<{ address: string; creator: string }>(
      `SELECT address, creator FROM agents WHERE task LIKE 'track calls%'`,
    );
    const agent = rows[0].address;
    const creator = rows[0].creator;

    // A call to a non-existent integration fails fast — but the audit
    // letter is still written (the house records what the instrument
    // attempted).
    const res = await house.integrations.call(agent, "no-such-integration", "search", { q: "grants" });
    expect(res.ok).toBe(false);

    // The audit letter exists, addressed to the creator and the agent.
    const audit = await house.db.pool.query<{ from_addr: string; to_addrs: string[] }>(
      `SELECT from_addr, to_addrs FROM letters WHERE subject LIKE 'integration call%' ORDER BY created_at DESC LIMIT 1`,
    );
    expect(audit.rows).toHaveLength(1);
    expect(audit.rows[0].from_addr).toBe(agent);
    expect(audit.rows[0].to_addrs).toContain(creator);
    expect(audit.rows[0].to_addrs).toContain(agent);
  });
});
