/**
 * OIDC is a door, not an identity — SPEC §19, hermetic unit tests.
 *
 * The load-bearing property: the OIDC binding is keyed by the IDENTITY
 * (the key fingerprint), never the handle — so a handle change, a
 * provider change, or a key rotation never severs the person from their
 * correspondence.
 */
import { describe, it, expect } from "vitest";
import { AuthService } from "../../src/auth/service.js";

// A minimal fake pool: rows keyed by SQL (each test exercises one query).
function fakePool(rows: Record<string, unknown[]> = {}) {
  return {
    query: async (sql: string) => {
      return { rows: rows[sql] ?? [] };
    },
  } as never;
}

const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as never;
const cfg = { mode: "both" as const, oidc: { issuer: "https://auth.example.com" } };

function svc(pool: ReturnType<typeof fakePool> = fakePool()) {
  return new AuthService(pool, noopLog, cfg);
}

describe("the binding is keyed by identity, never the handle", () => {
  it("bindOidc writes the binding keyed by the identity id, not the handle", async () => {
    const queries: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params: unknown[] = []) => {
        queries.push({ sql, params });
        // The identity lookup returns a key fingerprint.
        if (sql.includes("SELECT identity_id FROM addresses")) {
          return { rows: [{ identity_id: "key-fingerprint" }] };
        }
        return { rows: [] };
      },
    } as never;
    const s = svc(pool);
    await s.bindOidc("ben@house", "sub-123");

    // The binding INSERT carries the identity id, never the handle.
    const insert = queries.find((q) => q.sql.includes("INSERT INTO oidc_bindings"));
    expect(insert).toBeDefined();
    expect(insert!.params[0]).toBe("key-fingerprint");
    expect(insert!.params[1]).toBe("voidauth");
    expect(insert!.params[2]).toBe("sub-123");
  });

  it("the identity id is the key fingerprint, or the handle for legacy addresses", async () => {
    const withKey = svc(
      fakePool({
        "SELECT identity_id FROM addresses WHERE id = $1": [{ identity_id: "key-fingerprint" }],
      }),
    );
    const identity = await (withKey as unknown as { identityIdFor: (a: string) => Promise<string> }).identityIdFor("ben@house");
    expect(identity).toBe("key-fingerprint");

    // Legacy — no key, the identity IS the handle.
    const legacy = svc(fakePool());
    const legacyIdentity = await (legacy as unknown as { identityIdFor: (a: string) => Promise<string> }).identityIdFor("ben@house");
    expect(legacyIdentity).toBe("ben@house");
  });
});
