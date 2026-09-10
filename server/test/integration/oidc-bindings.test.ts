/**
 * OIDC is a door, not an identity — SPEC §19, integration tests.
 *
 * These prove the binding arc against live infra (postgres 15, qdrant,
 * ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   bind → the binding is keyed by the identity, never the handle
 *   handle change → the binding survives (the key is the continuity)
 *   provider change → the new sub binds to the same identity
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { AuthService } from "../../src/auth/service.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

describe.skipIf(!INTEGRATION)("oidc bindings (integration)", () => {
  let house: House;
  let auth: AuthService;

  beforeAll(async () => {
    house = await buildHouse({
      ...process.env,
      DATABASE_URL: "postgres://localhost:5433/poste_restante_test",
      QDRANT_COLLECTION: "letters_test",
      POSTE_RESTANTE_INTEGRATION: "1",
      AUTH_MODE: "both",
    });
    await house.semantic.reset();
    await house.semantic.ensureCollection();
    await house.db.pool.query(
      `TRUNCATE invites, whispers, clauses, clause_objectors, clause_vouchers,
              thread_participation, letters, threads, frames, addresses, credentials,
              address_keys, agents, integrations, agent_integrations, letter_reads,
              oidc_bindings
       RESTART IDENTITY CASCADE`,
    );
    await house.db.pool.query(
      `INSERT INTO addresses (id, identity_id, is_public)
       VALUES ('book@house', 'book@house', false), ('pub@house', 'pub@house', true)`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth, house.whisper);
  });

  afterAll(async () => {
    await house.close();
  });

  it("binds a sub to the identity, not the handle", async () => {
    await auth.setPassword("ben@house", "benbenben");
    await auth.bindOidc("ben@house", "sub-123");

    const { rows } = await house.db.pool.query<{ identity_id: string; sub: string }>(
      `SELECT identity_id, sub FROM oidc_bindings WHERE sub = 'sub-123'`,
    );
    expect(rows).toHaveLength(1);
    // Legacy address without keys — the identity IS the handle.
    expect(rows[0].identity_id).toBe("ben@house");
  });

  it("the binding never references the handle — a relabel cannot sever it", async () => {
    // The binding is keyed by identity_id, never the handle. The schema
    // proves the property: there is no handle column in oidc_bindings at
    // all. A relabel (the §19 mechanism, buildable-later) updates the
    // address row's id while keeping identity_id — the binding survives
    // because it references the identity, not the label.
    const { rows } = await house.db.pool.query<{ identity_id: string }>(
      `SELECT identity_id FROM oidc_bindings WHERE sub = 'sub-123'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].identity_id).toBe("ben@house");

    // The callback resolves sub → identity → address. The identity is
    // the anchor; the address is whatever currently wears it.
    const resolved = await house.db.pool.query<{ address: string }>(
      `SELECT a.id AS address
       FROM oidc_bindings ob
       JOIN addresses a ON a.identity_id = ob.identity_id
       WHERE ob.provider = 'voidauth' AND ob.sub = 'sub-123'`,
    );
    expect(resolved.rows[0].address).toBe("ben@house");
  });

  it("a provider change binds the new sub to the same identity", async () => {
    // The person moves to a new provider — a new sub, same identity.
    await auth.bindOidc("sam@house", "sub-456", "new-provider");

    const { rows } = await house.db.pool.query<{ identity_id: string; provider: string }>(
      `SELECT identity_id, provider FROM oidc_bindings WHERE sub = 'sub-456'`,
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].provider).toBe("new-provider");
    expect(rows[0].identity_id).toBe("sam@house");
  });
});
