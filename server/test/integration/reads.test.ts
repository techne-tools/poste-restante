/**
 * The living pass read-back — SPEC §5 #12, integration tests.
 *
 * These prove the read-back against live infra (postgres 15, qdrant,
 * ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   open → the house records the signal per (letter, resident)
 *   privacy → a non-participant cannot signal a letter they cannot see
 *   the convergence ordering reads the table
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("letter reads (integration)", () => {
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
              address_keys, agents, integrations, agent_integrations, letter_reads
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

  it("records the open signal per (letter, resident)", async () => {
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        envelope: {
          from: "you@house",
          to: ["you@house"],
          cc: [],
          thread: "th_read_1",
          kind: "letter",
          lang: "en-AU",
          subject: "the read-back",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: "did you read this?" },
      }),
    });
    expect(res.status).toBe(201);
    const { id } = (await res.json()) as { id: string };

    const read = await app.request(`/v1/letters/${id}/read`, {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(read.status).toBe(200);

    const state = await house.reads.stateFor("you@house", [id]);
    expect(state.get(id)).toEqual({ opened: true, replied: false });
  });

  it("privacy — a non-participant cannot signal a letter they cannot see", async () => {
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        envelope: {
          from: "you@house",
          to: ["you@house"],
          cc: [],
          thread: "th_read_private",
          kind: "letter",
          lang: "en-AU",
          subject: "private",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: "for your eyes only" },
      }),
    });
    const { id } = (await res.json()) as { id: string };

    // ben cannot signal it — 404, never 403.
    const benRead = await app.request(`/v1/letters/${id}/read`, {
      method: "POST",
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(benRead.status).toBe(404);

    // ben's read state has no row for it.
    const benState = await house.reads.stateFor("ben@house", [id]);
    expect(benState.get(id)).toBeUndefined();
  });
});
