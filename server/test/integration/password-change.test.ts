/**
 * The password change — the resident's own door (SPEC §5, auth).
 * Integration tests. These prove the full arc against live infra
 * (postgres 15, qdrant, ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   change → the old password stops working, the new one authenticates
 *          → only the resident themselves may change their own door
 *          → a wrong current answers 409 — the refusal of the house's
 *            conflict register (the session is live; only the secret
 *            refuses), never 401 — and records a door-knock (the house
 *            tells the resident someone knocked with the wrong key)
 *          → a short next password is refused before the door turns
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("password change (integration)", () => {
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
    await auth.setPassword("ben@house", "old-password-1");
    app = createLetterServer(house, { auth });
  });

  afterAll(async () => {
    await house.close();
  });

  it("changes the password — the old one stops working, the new one authenticates", async () => {
    const change = await app.request("/v1/addresses/ben@house/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("ben@house", "old-password-1") },
      body: JSON.stringify({ current: "old-password-1", next: "new-password-1" }),
    });
    expect(change.status).toBe(200);
    const json = (await change.json()) as { changed: boolean; address: string };
    expect(json.changed).toBe(true);
    expect(json.address).toBe("ben@house");

    // The old credential is dead.
    const oldAuth = await app.request("/v1/letters", {
      method: "GET",
      headers: { Authorization: basic("ben@house", "old-password-1") },
    });
    expect(oldAuth.status).toBe(401);

    // The new credential opens the house.
    const newAuth = await app.request("/v1/letters", {
      method: "GET",
      headers: { Authorization: basic("ben@house", "new-password-1") },
    });
    expect(newAuth.status).toBe(200);
  });

  it("answers 401 for a wrong current password — and records a door-knock", async () => {
    // Reset ben's door to a known state first.
    await auth.setPassword("ben@house", "old-password-2");
    let knocks = 0;
    const spyWhisper = {
      recordDoorKnock: async () => {
        knocks += 1;
      },
    } as never;
    const spyAuth = new AuthService(house.db.pool, house.log, house.config.auth, spyWhisper);
    const spyApp = createLetterServer(house, { auth: spyAuth });

    const wrong = await spyApp.request("/v1/addresses/ben@house/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("ben@house", "old-password-2") },
      body: JSON.stringify({ current: "wrong-current", next: "new-password-2" }),
    });
    // 409, never 401: the caller is authenticated (the session is live);
    // the current secret refuses the turn. A 401 with a credential
    // attached would make the client treat a live session as dead and
    // sign the resident out — the resident stays seated and can try
    // again.
    expect(wrong.status).toBe(409);
    expect(knocks).toBe(1);

    // The door did not turn — the old password still works.
    const stillWorks = await spyApp.request("/v1/letters", {
      method: "GET",
      headers: { Authorization: basic("ben@house", "old-password-2") },
    });
    expect(stillWorks.status).toBe(200);
  });

  it("only the resident themselves may change their own door", async () => {
    await auth.setPassword("you@house", "youyouyou");
    const res = await app.request("/v1/addresses/you@house/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("ben@house", "old-password-2") },
      body: JSON.stringify({ current: "youyouyou", next: "somenewpass" }),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a short next password before the door turns", async () => {
    const res = await app.request("/v1/addresses/ben@house/password", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("ben@house", "old-password-2") },
      body: JSON.stringify({ current: "old-password-2", next: "short" }),
    });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("invalid_password_change");
  });
});
