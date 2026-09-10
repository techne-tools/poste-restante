/**
 * The day projection — the callsheet whiteboard (SPEC §18), integration tests.
 *
 * These prove the derived view against live infra (postgres 15, qdrant,
 * ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   letters in the resident's visible frames → the board's rows
 *   the resident's instruments → the board's task lines
 *   privacy → a non-participant's board never names a thread they
 *             cannot see
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

describe.skipIf(!INTEGRATION)("day projection (integration)", () => {
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
    await auth.setPassword("ben@house", "benbenben");
    app = createLetterServer(house, { auth });
  });

  afterAll(async () => {
    await house.close();
  });

  it("projects the resident's day — letters in their visible frames", async () => {
    // A letter in a frame the resident is party to.
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        envelope: {
          from: "you@house",
          to: ["you@house"],
          cc: [],
          thread: "th_day_1",
          kind: "letter",
          lang: "en-AU",
          subject: "the tempest tech week",
        },
        time: {
          gregorian: new Date().toISOString(),
          frames: [{ frame: "production", value: "tempest-tech-week" }],
        },
        body: { format: "markdown", content: "cue 47 at eighty" },
      }),
    });
    expect(res.status).toBe(201);

    const day = await app.request("/v1/day", {
      method: "GET",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(day.status).toBe(200);
    const projection = (await day.json()) as {
      frames: { frame: string; letters: { subject: string }[] }[];
    };
    const frame = projection.frames.find((f) => f.frame === "production:tempest-tech-week");
    expect(frame).toBeDefined();
    expect(frame!.letters.some((l) => l.subject === "the tempest tech week")).toBe(true);
  });

  it("projects the resident's instruments — the board's task lines", async () => {
    // Mint an agent.
    const birth = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        envelope: {
          from: "you@house",
          to: [AgentService.AGENTS_ADDRESS],
          cc: [],
          thread: "th_day_agent",
          kind: "agent",
          lang: "en-AU",
          subject: "grantwatch",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: "track calls for international arts grants" },
      }),
    });
    expect(birth.status).toBe(201);

    const day = await app.request("/v1/day", {
      method: "GET",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const projection = (await day.json()) as { agents: { task: string }[] };
    expect(projection.agents.some((a) => a.task.includes("arts grants"))).toBe(true);
  });

  it("privacy — a non-participant's board never names a thread they cannot see", async () => {
    // ben's board: no letters in you's frame, no agents.
    const day = await app.request("/v1/day", {
      method: "GET",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(day.status).toBe(200);
    const projection = (await day.json()) as {
      frames: { frame: string; letters: { subject: string }[] }[];
      agents: { task: string }[];
    };
    // ben is party to nothing — the board is empty, never a leak.
    expect(projection.frames.every((f) => f.letters.length === 0)).toBe(true);
    expect(projection.agents).toHaveLength(0);
  });
});
