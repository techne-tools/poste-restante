/**
 * HouseKeysService — the house's own keypair (SPEC §15, second model),
 * hermetic unit tests.
 *
 * These prove the pure provisioning without infra: the singleton
 * structure, the public-half mirror, and the collaborative
 * unseal capability (only letters sealed WITH the house open).
 */
import { describe, it, expect } from "vitest";
import { HouseKeysService, HOUSE_ADDRESS } from "../../src/house/keys.js";
import { generateResidentKeypair, sealToRecipients } from "../../src/crypto/keys.js";

function fakePool(over: Partial<{ rows: unknown[] }> = {}) {
  let houseKeysRow: unknown = over.rows?.[0] ?? null;
  return {
    query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("FROM house_keys")) {
        return { rows: houseKeysRow ? [houseKeysRow] : [], params };
      }
      if (sql.includes("INSERT INTO house_keys")) {
        const [ageIdentity, ageRecipient, ed25519Private, ed25519Public] = params ?? [];
        houseKeysRow = {
          age_identity: ageIdentity,
          age_recipient: ageRecipient,
          ed25519_private: ed25519Private,
          ed25519_public: ed25519Public,
        };
        return { rows: [], params };
      }
      return { rows: [], params };
    },
  } as never;
}

const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as never;

function svc(pool: ReturnType<typeof fakePool> = fakePool()) {
  return new HouseKeysService(pool, noopLog);
}

describe("HouseKeysService — the singleton", () => {
  it("returns null when the house has no key — not yet provisioned", async () => {
    const s = svc();
    expect(await s.get()).toBeNull();
  });

  it("does not re-provision when the key already exists — idempotent", async () => {
    const existing = {
      age_identity: "AGE-SECRET-1",
      age_recipient: "age1pub0",
      ed25519_private: "ed-secret-1",
      ed25519_public: "ed-pub-1",
    };
    const pool = fakePool({ rows: [existing] });
    const s = svc(pool);

    // A second call hits the SELECT path (already exists) — no INSERT.
    const key = await s.ensure();

    // The pool received the SELECT (rows present) — ensure returns the
    // stored key, not a fresh one.
    expect(key.ageRecipient).toBe("age1pub0");
    expect(key.ed25519Public).toBe("ed-pub-1");
  });

  it("provisions once when missing — the singleton INSERT is idempotent", async () => {
    const pool = fakePool();
    const s = svc(pool);

    // First ensure: SELECT returns nothing → the service generates,
    // inserts, then re-reads (still nothing in the fake — the
    // concurrent-first-wins path takes the generated key).
    const key = await s.ensure();
    expect(key.ageIdentity).toBeTruthy();
    expect(key.ageRecipient).toBeTruthy();
    expect(key.ed25519Public).toBeTruthy();
  });

  it("mirrors the public halves into the address book for house@house", async () => {
    const inserts: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params?: unknown[]) => {
        inserts.push({ sql, params: params ?? [] });
        if (sql.includes("FROM house_keys")) return { rows: [] };
        return { rows: [] };
      },
    } as never;
    const s = new HouseKeysService(pool, noopLog);
    await s.ensure();

    const addressInsert = inserts.find((i) => i.sql.includes("INSERT INTO addresses"));
    expect(addressInsert).toBeDefined();
    expect(addressInsert!.params).toContain(HOUSE_ADDRESS);

    const keyInsert = inserts.find((i) => i.sql.includes("INSERT INTO address_keys"));
    expect(keyInsert).toBeDefined();
  });

  it("unseals collaborative letters only — a private seal stays closed", async () => {
    // Provision the house key.
    const pool = fakePool();
    const s = svc(pool);
    const house = await s.ensure();

    // A resident seals a letter WITH the house.
    const resident = await generateResidentKeypair("you@house");
    const collaborative = await sealToRecipients("the house can read this", [
      resident.public.ageRecipient,
      house.ageRecipient,
    ]);
    expect(await s.unsealBody(collaborative)).toBe("the house can read this");

    // And WITHOUT the house — the house cannot open it.
    const privateSeal = await sealToRecipients("only the recipient", [
      resident.public.ageRecipient,
    ]);
    expect(await s.unsealBody(privateSeal)).toBeNull();
  });
});
