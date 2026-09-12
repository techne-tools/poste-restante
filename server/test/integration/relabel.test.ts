/**
 * The relabel mechanism — SPEC §19, integration tests.
 *
 * These prove the full arc against live infra (postgres 15, qdrant,
 * ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   relabel → the handle changes, the identity stays
 *           → every edge cascades (credentials, letters, participation)
 *           → the letter ids stay (the identity is the anchor)
 *           → the old handle is retired — a deadname must not become
 *             someone else's name
 *           → only the resident themselves may relabel
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("relabel (integration)", () => {
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
              address_keys, agents, integrations, agent_integrations, letter_reads,
              oidc_bindings, retired_handles
       RESTART IDENTITY CASCADE`,
    );
    await house.db.pool.query(
      `INSERT INTO addresses (id, identity_id, is_public)
       VALUES ('book@house', 'book@house', false), ('pub@house', 'pub@house', true)`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth, house.whisper);
    await auth.setPassword("ben@house", "benbenben");
    app = createLetterServer(house, { auth });
  });

  afterAll(async () => {
    await house.close();
  });

  it("relabels the handle — the identity stays, the edges cascade", async () => {
    // A letter from ben, addressed to ben — the edge exists.
    const res = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("ben@house", "benbenben") },
      body: JSON.stringify({
        envelope: {
          from: "ben@house",
          to: ["ben@house"],
          cc: [],
          thread: "th_relabel_1",
          kind: "letter",
          lang: "en-AU",
          subject: "the tempest",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: "the storm is coming" },
      }),
    });
    expect(res.status).toBe(201);
    const { id: letterId } = (await res.json()) as { id: string };

    // ben relabels to sam.
    const relabel = await app.request("/v1/addresses/ben@house/relabel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("ben@house", "benbenben") },
      body: JSON.stringify({ handle: "sam@house" }),
    });
    expect(relabel.status).toBe(200);

    // The address row: the handle changed, the identity stayed — the
    // identity is the anchor, it must NOT change on relabel.
    const addr = await house.db.pool.query<{ id: string; identity_id: string }>(
      `SELECT id, identity_id FROM addresses WHERE id = 'sam@house'`,
    );
    expect(addr.rows).toHaveLength(1);
    expect(addr.rows[0].identity_id).toBe("ben@house");

    // The credential cascaded — sam can authenticate.
    const samAuth = await app.request("/v1/letters", {
      method: "GET",
      headers: { Authorization: basic("sam@house", "benbenben") },
    });
    expect(samAuth.status).toBe(200);

    // The letter's participant edge cascaded — sam is party to it.
    const letter = await house.repo.getLetter(letterId);
    expect(letter).not.toBeNull();
    const edge = await house.db.pool.query<{ address_id: string }>(
      `SELECT address_id FROM letter_addresses WHERE letter_id = $1 AND address_id = 'sam@house'`,
      [letterId],
    );
    expect(edge.rows).toHaveLength(1);

    // The stored envelope strings swept — the archive shows the new
    // handle everywhere the old one was (SPEC §19). The letter id did NOT
    // change (the id hashes the identity, not the handle).
    const swept = await house.db.pool.query<{ from_addr: string; to_addrs: string[] }>(
      `SELECT from_addr, to_addrs FROM letters WHERE id = $1`,
      [letterId],
    );
    expect(swept.rows).toHaveLength(1);
    expect(swept.rows[0].from_addr).toBe("sam@house");
    expect(swept.rows[0].to_addrs).toContain("sam@house");
    expect(swept.rows[0].to_addrs).not.toContain("ben@house");

    // The old handle is retired — a deadname must not become someone
    // else's name.
    const retired = await house.db.pool.query<{ handle: string }>(
      `SELECT handle FROM retired_handles WHERE handle = 'ben@house'`,
    );
    expect(retired.rows).toHaveLength(1);

    // The retired handle cannot be claimed.
    const reclaim = await app.request("/v1/addresses/sam@house/relabel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("sam@house", "benbenben") },
      body: JSON.stringify({ handle: "ben@house" }),
    });
    expect(reclaim.status).toBe(409);
    const body = (await reclaim.json()) as { error: { code: string } };
    expect(body.error.code).toBe("handle_taken");
  });

  it("only the resident themselves may relabel", async () => {
    await auth.setPassword("you@house", "youyouyou");
    const res = await app.request("/v1/addresses/you@house/relabel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("sam@house", "benbenben") },
      body: JSON.stringify({ handle: "someone-else@house" }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a handle that is not a valid address", async () => {
    // By now ben@house has been relabelled to sam@house (the credential
    // cascaded); sam is the live handle to try a malformed one against.
    const res = await app.request("/v1/addresses/sam@house/relabel", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("sam@house", "benbenben") },
      body: JSON.stringify({ handle: "not an address" }),
    });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("invalid_handle");
  });
});
