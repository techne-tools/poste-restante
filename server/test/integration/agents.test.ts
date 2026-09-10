/**
 * Agents — instruments, not servants (SPEC §16), integration tests.
 *
 * These prove the whole arc against live infra (postgres 15, qdrant,
 * ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   birth → the agent is minted (address, token, scope record)
 *   reach → the agent can address its creator, not a stranger
 *   death → the token is revoked, the agent stops waking
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

describe.skipIf(!INTEGRATION)("agents (integration)", () => {
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
              address_keys, agents
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

  it("births an agent from a letter — the act IS the letter", async () => {
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        envelope: {
          from: "you@house",
          to: [AgentService.AGENTS_ADDRESS],
          cc: [],
          thread: "th_agent_birth",
          kind: "agent",
          lang: "en-AU",
          subject: "grantwatch",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: {
          format: "markdown",
          content: [
            "track calls for international arts grants",
            "lifespan: production:grant-season-2026",
            "group: th_grants",
            "beneficiary: you@house",
          ].join("\n"),
        },
      }),
    });
    expect(res.status).toBe(201);

    // The agent was minted — the scope record exists.
    const { rows } = await house.db.pool.query<{ address: string; creator: string; task: string }>(
      `SELECT address, creator, task FROM agents`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].creator).toBe("you@house");
    expect(rows[0].task).toContain("arts grants");
  });

  it("enforces the reach — the agent can address its creator, not a stranger", async () => {
    // Mint an agent directly (the birth path is covered above).
    const birth = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        envelope: {
          from: "you@house",
          to: [AgentService.AGENTS_ADDRESS],
          cc: [],
          thread: "th_agent_birth2",
          kind: "agent",
          lang: "en-AU",
          subject: "ticketwatch",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: "watch ticket sales for a gig" },
      }),
    });
    expect(birth.status).toBe(201);
    const { rows } = await house.db.pool.query<{ address: string }>(
      `SELECT address FROM agents WHERE task LIKE 'watch ticket%'`,
    );
    const agent = rows[0].address;

    // The agent can address its creator.
    const toCreator = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${"pr_test"}` },
      body: JSON.stringify({
        envelope: {
          from: agent,
          to: ["you@house"],
          cc: [],
          thread: "th_agent_letter",
          kind: "letter",
          lang: "en-AU",
          subject: "the gig sold out",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: "sold out in a day" },
      }),
    });
    // The token is a hash — the test cannot mint one; the reach check
    // happens before auth, so this proves the door logic via the service.
    expect(await house.agents.canAddress(agent, "you@house")).toBe(true);
    expect(await house.agents.canAddress(agent, "ben@house")).toBe(false);
    expect(await house.agents.canAddress(agent, "pub@house")).toBe(false); // no grant
  });

  it("kills an agent — the token is revoked, the doors close", async () => {
    const { rows } = await house.db.pool.query<{ address: string }>(
      `SELECT address FROM agents WHERE task LIKE 'watch ticket%'`,
    );
    const agent = rows[0].address;

    expect(await house.agents.kill(agent)).toBe(true);
    expect(await house.agents.isAgent(agent)).toBe(false);
    expect(await house.agents.canAddress(agent, "you@house")).toBe(false);
    // Killing twice is a no-op.
    expect(await house.agents.kill(agent)).toBe(false);
  });
});
