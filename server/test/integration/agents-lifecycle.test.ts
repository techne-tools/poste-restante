/**
 * Agents — instruments, not servants (SPEC §16), integration tests.
 *
 * These prove the full lifecycle against live infra (postgres 15, qdrant,
 * ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   birth  → the agent address materialises, the token is minted,
 *            the instrument appears marked in the address book
 *   alive  → its doors are open (creator, group), it can deliver
 *   quiet  → a lifespan frame with no activity for the window
 *   death  → the sweep writes the final letter to the creator and
 *            revokes the token — no doors, no zombie
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import { AgentService } from "../../src/agents/service.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";
// The birth address derives from the task slug, sliced to 40 chars —
// "track calls for international arts grants" → "…international-arts-grant".
const AGENT_ADDRESS = "track-calls-for-international-arts-grant@house";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("agents lifecycle (integration)", () => {
  let house: House;
  let auth: AuthService;
  let app: ReturnType<typeof createLetterServer>;
  let sweptAt: Date;

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
              address_keys, agents, integrations, agent_integrations, letter_reads,
              oidc_bindings, retired_handles
       RESTART IDENTITY CASCADE`,
    );
    await house.db.pool.query(
      `INSERT INTO addresses (id, identity_id, is_public)
       VALUES ('book@house', 'book@house', false), ('pub@house', 'pub@house', true)`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth, house.whisper);
    await auth.setPassword("you@house", "youyouyou");
    app = createLetterServer(house, { auth });
    sweptAt = new Date();
  });

  afterAll(async () => {
    await house.close();
  });

  it("births an agent with a lifespan frame — the instrument is marked and its doors are open", async () => {
    // The birth letter — the act IS the letter, the will is the body.
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        envelope: {
          from: "you@house",
          to: ["agents@house"],
          cc: [],
          thread: "th_birth_1",
          kind: "agent",
          lang: "en-AU",
          subject: "",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: {
          format: "markdown",
          content: [
            "track calls for international arts grants",
            "lifespan: production:grant-season-2026",
            "group: th_grants",
          ].join("\n"),
        },
      }),
    });
    expect(res.status).toBe(201);

    // The agent address exists with a token (the birth path mints it).
    const agent = await house.db.pool.query<{ address: string; token_hash: string | null }>(
      `SELECT address, token_hash FROM agents WHERE address = $1`,
      [AGENT_ADDRESS],
    );
    expect(agent.rows).toHaveLength(1);
    expect(agent.rows[0].token_hash).not.toBeNull();
    const address = agent.rows[0].address;

    // The instrument is marked in the address book, flat and honest.
    const bookRes = await app.request("/v1/addresses", {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const book = (await bookRes.json()) as {
      addresses: { id: string; isAgent: boolean }[];
    };
    const row = book.addresses.find((a) => a.id === address);
    expect(row?.isAgent).toBe(true);

    // The agent's doors are open — it can address its creator.
    const service = new AgentService(
      house.db.pool,
      house.repo,
      house.pipeline,
      house.log,
    );
    expect(await service.canAddress(address, "you@house")).toBe(true);
    expect(await service.canAddress(address, "th_grants")).toBe(true);
    // A stranger is still not a door.
    expect(await service.canAddress(address, "ben@house")).toBe(false);
  });

  it("the sweep leaves a live agent alone", async () => {
    // No agent in the fixture has a quiet frame yet (all frames have
    // recent activity or no lifespan at all) — the sweep kills nothing.
    const service = new AgentService(house.db.pool, house.repo, house.pipeline, house.log);
    const killed = await service.sweepExpired(sweptAt, 10 * 24 * 60 * 60 * 1000);
    expect(killed).toEqual([]);
  });

  it("sweeps a life whose frame has gone quiet — final letter, token revoked, doors closed", async () => {
    // Create a frame the grant-scraper lives in, with NO letters inside
    // the window — the frame has closed.
    // (letters_frames rows are created by ingest; the simplest quiet frame
    // is a frame value with no letter at all — the NOT EXISTS holds.)
    const service = new AgentService(house.db.pool, house.repo, house.pipeline, house.log);

    const before = await house.db.pool.query<{ address: string }>(
      `SELECT address FROM agents WHERE lifespan_frame = 'production:grant-season-2026'`,
    );
    expect(before.rows.length).toBeGreaterThan(0);

    // Age the instrument past its grace period — an agent born this
    // second must not die before living a full window (a.created_at <=
    // cutoff in the sweep query keeps fresh births safe).
    await house.db.pool.query(
      `UPDATE agents SET created_at = now() - interval '31 days'
       WHERE address = $1 AND lifespan_frame = 'production:grant-season-2026'`,
      [AGENT_ADDRESS],
    );

    // The window has no letters in that frame — but the agent's own
    // birth frame (production:grant-season-2026) was never used as a
    // letter frame, so the sweep sees a quiet frame and kills.
    const killed = await service.sweepExpired(sweptAt, 24 * 60 * 60 * 1000);
    expect(killed).toContain(AGENT_ADDRESS);

    // The archive holds the final letter — the instrument's own word,
    // to its creator.
    const finalLetters = await house.db.pool.query<{ from_addr: string; to_addrs: string[]; body: string }>(
      `SELECT from_addr, to_addrs, body FROM letters
       WHERE from_addr = $1
       ORDER BY received_at DESC LIMIT 1`,
      [AGENT_ADDRESS],
    );
    expect(finalLetters.rows).toHaveLength(1);
    expect(finalLetters.rows[0].to_addrs).toContain("you@house");
    expect(finalLetters.rows[0].body).toContain("track calls for international arts grants");
    expect(finalLetters.rows[0].body).toContain("my frame closed — this task is done.");

    // No doors remain — the instrument is dead.
    const after = await house.db.pool.query<{ died_at: string | null; token_hash: string | null }>(
      `SELECT died_at, token_hash FROM agents WHERE address = $1`,
      [AGENT_ADDRESS],
    );
    expect(after.rows[0].died_at).not.toBeNull();
    expect(after.rows[0].token_hash).toBeNull();
    expect(await service.canAddress(AGENT_ADDRESS, "you@house")).toBe(false);

    // The address book no longer marks it as an instrument.
    const bookRes = await app.request("/v1/addresses", {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const book = (await bookRes.json()) as {
      addresses: { id: string; isAgent: boolean }[];
    };
    const row = book.addresses.find((a) => a.id === AGENT_ADDRESS);
    expect(row?.isAgent).toBe(false);

    // Idempotent — a second sweep is a no-op.
    const again = await service.sweepExpired(sweptAt, 24 * 60 * 60 * 1000);
    expect(again).toEqual([]);
  });
});
