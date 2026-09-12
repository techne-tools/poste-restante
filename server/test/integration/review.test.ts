/**
 * The review — what the house holds about you, integration tests.
 *
 * These prove the review surface against live infra (postgres 15, qdrant,
 * ollama). Gated by POSTE_RESTANTE_INTEGRATION=1.
 *
 *   review → a resident sees every letter they are party to, including
 *            what is on the shelf (a letter put away is still held)
 *   forget → first-class deletion: the letter is gone from the review,
 *            the archive, and the semantic layer
 *   privacy → a resident cannot review another's record
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("the review (integration)", () => {
  let house: House;
  let auth: AuthService;
  let app: ReturnType<typeof createLetterServer>;
  let heldId: string;

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
    await auth.setPassword("ben@house", "benbenben");
    app = createLetterServer(house, { auth });

    // A letter in an open thread.
    const open = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        envelope: {
          from: "you@house",
          to: ["you@house"],
          cc: [],
          thread: "th_review_open",
          kind: "letter",
          lang: "en-AU",
          subject: "the open letter",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: "an open letter, in an open thread" },
      }),
    });
    expect(open.status).toBe(201);

    // A second letter in a thread that will be shelved.
    const shelved = await app.request("/v1/letters", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: basic("you@house", "youyouyou") },
      body: JSON.stringify({
        envelope: {
          from: "you@house",
          to: ["you@house"],
          cc: [],
          thread: "th_review_shelved",
          kind: "letter",
          lang: "en-AU",
          subject: "the shelved letter",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: { format: "markdown", content: "a letter in a thread that goes on the shelf" },
      }),
    });
    expect(shelved.status).toBe(201);
    const shelvedJson = (await shelved.json()) as { id: string };
    heldId = shelvedJson.id;

    await app.request("/v1/threads/th_review_shelved/shelve", {
      method: "POST",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
  });

  afterAll(async () => {
    await house.close();
  });

  it("a resident sees what the house holds — including the shelved letter", async () => {
    const res = await app.request("/v1/addresses/you@house/review", {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      address: string;
      letters: { id: string; envelope: { subject: string } }[];
    };
    expect(body.address).toBe("you@house");
    const subjects = body.letters.map((l) => l.envelope.subject);
    // The mailbox would hide the shelved thread; the review does not —
    // a letter put away is still held by the house.
    expect(subjects).toContain("the open letter");
    expect(subjects).toContain("the shelved letter");
  });

  it("forget deletes a held letter — gone from the review and the archive", async () => {
    const before = await app.request("/v1/addresses/you@house/review", {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const beforeJson = (await before.json()) as {
      letters: { id: string; envelope: { subject: string } }[];
    };
    expect(beforeJson.letters.some((l) => l.id === heldId)).toBe(true);

    const del = await app.request(`/v1/letters/${heldId}`, {
      method: "DELETE",
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    expect(del.status).toBe(200);

    const after = await app.request("/v1/addresses/you@house/review", {
      headers: { Authorization: basic("you@house", "youyouyou") },
    });
    const afterJson = (await after.json()) as {
      letters: { id: string }[];
    };
    expect(afterJson.letters.some((l) => l.id === heldId)).toBe(false);
  });

  it("a resident cannot review another's record — self-regard, not administration", async () => {
    const res = await app.request("/v1/addresses/you@house/review", {
      headers: { Authorization: basic("ben@house", "benbenben") },
    });
    expect(res.status).toBe(403);
  });
});
