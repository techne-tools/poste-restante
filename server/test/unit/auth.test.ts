/**
 * Auth unit tests — hermetic. The pool is faked; no postgres required.
 * These verify the credential primitives: scrypt hashing, bearer tokens,
 * mode gating, and the visibility rule (participant-or-pub, 404 not 403).
 */
import { describe, it, expect } from "vitest";
import {
  hashPassword,
  verifyPassword,
  hashToken,
  generateToken,
  AuthService,
} from "../../src/auth/service.js";
import { isVisibleTo, isPublicLetter, PUB_ADDRESS } from "../../src/auth/visibility.js";
import type { AuthConfig } from "../../src/auth/service.js";

/** A minimal fake pool: rows keyed by SQL (each test exercises one query). */
function fakePool(rows: Record<string, unknown[]> = {}) {
  return {
    query: async (sql: string) => {
      return { rows: rows[sql] ?? [] };
    },
  } as never;
}

const cfg = (mode: AuthConfig["mode"]): AuthConfig => ({ mode });

const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as never;

describe("password hashing", () => {
  it("round-trips a password through scrypt", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(stored.startsWith("scrypt$")).toBe(true);
    expect(verifyPassword("correct horse battery staple", stored)).toBe(true);
  });

  it("rejects a wrong password", () => {
    const stored = hashPassword("correct horse battery staple");
    expect(verifyPassword("wrong password", stored)).toBe(false);
  });

  it("salts — the same password hashes differently each time", () => {
    const a = hashPassword("same");
    const b = hashPassword("same");
    expect(a).not.toBe(b);
  });

  it("rejects a malformed stored hash", () => {
    expect(verifyPassword("x", "not-a-hash")).toBe(false);
    expect(verifyPassword("x", "scrypt$1$2$3$4")).toBe(false);
  });
});

describe("bearer tokens", () => {
  it("generates opaque tokens with the pr_ prefix", () => {
    const t = generateToken();
    expect(t.startsWith("pr_")).toBe(true);
    expect(t.length).toBeGreaterThan(20);
  });

  it("hashes tokens deterministically — the token itself is never stored", () => {
    const t = generateToken();
    expect(hashToken(t)).toBe(hashToken(t));
    expect(hashToken(t)).not.toBe(t);
  });
});

describe("OIDC sign-in tokens", () => {
  it("issues a token when the address keeps no password", async () => {
    const pool = fakePool({
      "SELECT kind FROM credentials WHERE address = $1": [],
    });
    const svc = new AuthService(pool, noopLog, cfg("oidc"));
    expect(await svc.issueOidcToken("you@house")).toMatch(/^pr_/);
  });

  it("refuses to clobber a password credential — one row per address", async () => {
    const calls: string[] = [];
    const pool = {
      query: async (sql: string) => {
        calls.push(sql);
        if (sql.includes("SELECT kind")) return { rows: [{ kind: "password" }] };
        return { rows: [] };
      },
    } as never;
    const svc = new AuthService(pool, noopLog, cfg("oidc"));
    expect(await svc.issueOidcToken("you@house")).toBeNull();
    // The password row was never touched.
    expect(calls.some((s) => s.includes("INSERT INTO credentials"))).toBe(false);
  });
});

describe("AuthService", () => {
  it("authenticates a basic credential", async () => {
    const stored = hashPassword("hunter2hunter2");
    const pool = fakePool({
      "SELECT secret FROM credentials WHERE address = $1 AND kind = 'password'": [
        { secret: stored },
      ],
    });
    const svc = new AuthService(pool, noopLog, cfg("basic"));
    const who = await svc.authenticate(
      `Basic ${Buffer.from("you@house:hunter2hunter2").toString("base64")}`,
    );
    expect(who).toEqual({ address: "you@house", method: "password" });
  });

  it("returns null for a wrong password — the caller decides (404, not 403)", async () => {
    const stored = hashPassword("hunter2hunter2");
    const pool = fakePool({
      "SELECT secret FROM credentials WHERE address = $1 AND kind = 'password'": [
        { secret: stored },
      ],
    });
    const svc = new AuthService(pool, noopLog, cfg("basic"));
    const who = await svc.authenticate(
      `Basic ${Buffer.from("you@house:wrong").toString("base64")}`,
    );
    expect(who).toBeNull();
  });

  it("whispers a door-knock on a wrong password for a known address", async () => {
    const stored = hashPassword("hunter2hunter2");
    const pool = fakePool({
      "SELECT secret FROM credentials WHERE address = $1 AND kind = 'password'": [
        { secret: stored },
      ],
    });
    let knocks = 0;
    const whisper = { recordDoorKnock: async () => { knocks += 1; } } as never;
    const svc = new AuthService(pool, noopLog, cfg("basic"), whisper);
    const who = await svc.authenticate(
      `Basic ${Buffer.from("you@house:wrong").toString("base64")}`,
    );
    expect(who).toBeNull();
    expect(knocks).toBe(1);
  });

  it("stays silent for an unknown address — no existence leak", async () => {
    const pool = fakePool(); // no credential row — the door does not exist
    let knocks = 0;
    const whisper = { recordDoorKnock: async () => { knocks += 1; } } as never;
    const svc = new AuthService(pool, noopLog, cfg("basic"), whisper);
    const who = await svc.authenticate(
      `Basic ${Buffer.from("ghost@house:hunter2hunter2").toString("base64")}`,
    );
    expect(who).toBeNull();
    expect(knocks).toBe(0);
  });

  it("changes the password when the current one verifies", async () => {
    const stored = hashPassword("old-password-1");
    const calls: { sql: string; params: unknown[] }[] = [];
    const pool = {
      query: async (sql: string, params: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("SELECT secret")) return { rows: [{ secret: stored }] };
        return { rows: [] };
      },
    } as never;
    const svc = new AuthService(pool, noopLog, cfg("basic"));
    const ok = await svc.changePassword("you@house", "old-password-1", "new-password-1");
    expect(ok).toBe(true);
    // One UPDATE, against a real scrypt hash of the NEW password.
    const update = calls.find((c) => c.sql.includes("UPDATE credentials"));
    expect(update).toBeDefined();
    const newHash = update!.params![1] as string;
    expect(verifyPassword("new-password-1", newHash)).toBe(true);
    expect(verifyPassword("old-password-1", newHash)).toBe(false);
  });

  it("refuses a change when the current password is wrong — and records a door-knock", async () => {
    const stored = hashPassword("old-password-1");
    let updated = false;
    const pool = {
      query: async (sql: string) => {
        if (sql.includes("SELECT secret")) return { rows: [{ secret: stored }] };
        if (sql.includes("UPDATE credentials")) updated = true;
        return { rows: [] };
      },
    } as never;
    let knocks = 0;
    const whisper = { recordDoorKnock: async () => { knocks += 1; } } as never;
    const svc = new AuthService(pool, noopLog, cfg("basic"), whisper);
    const ok = await svc.changePassword("you@house", "wrong-current", "new-password-1");
    expect(ok).toBe(false);
    expect(updated).toBe(false);
    expect(knocks).toBe(1);
  });

  it("returns null for an unknown address", async () => {
    const svc = new AuthService(fakePool(), noopLog, cfg("basic"));
    const who = await svc.authenticate(
      `Basic ${Buffer.from("ghost@house:hunter2hunter2").toString("base64")}`,
    );
    expect(who).toBeNull();
  });

  it("rejects basic when the mode does not allow it", async () => {
    const svc = new AuthService(fakePool(), noopLog, cfg("oidc"));
    const who = await svc.authenticate(
      `Basic ${Buffer.from("you@house:hunter2hunter2").toString("base64")}`,
    );
    expect(who).toBeNull();
  });

  it("authenticates a bearer token (agents)", async () => {
    const token = generateToken();
    const pool = fakePool({
      "SELECT address FROM credentials WHERE kind = 'token' AND secret = $1": [
        { address: "hermes@house" },
      ],
    });
    const svc = new AuthService(pool, noopLog, cfg("both"));
    const who = await svc.authenticate(`Bearer ${token}`);
    expect(who).toEqual({ address: "hermes@house", method: "token" });
  });

  it("returns null for a missing or malformed Authorization header", async () => {
    const svc = new AuthService(fakePool(), noopLog, cfg("both"));
    expect(await svc.authenticate(undefined)).toBeNull();
    expect(await svc.authenticate("")).toBeNull();
    expect(await svc.authenticate("Basic")).toBeNull();
    expect(await svc.authenticate("Digest abc")).toBeNull();
  });

  it("reports whether auth is enabled", () => {
    expect(new AuthService(fakePool(), noopLog, cfg("none")).enabled).toBe(false);
    expect(new AuthService(fakePool(), noopLog, cfg("basic")).enabled).toBe(true);
    expect(new AuthService(fakePool(), noopLog, cfg("both")).enabled).toBe(true);
  });

  it("reports whether OIDC is configured and enabled", () => {
    const withOidc = new AuthService(fakePool(), noopLog, {
      mode: "oidc",
      oidc: {
        issuer: "https://auth.example.com",
        clientId: "house",
        clientSecret: "secret",
        redirectUri: "https://house.example.com/v1/auth/oidc/callback",
        ownerAddress: "you@house",
      },
    });
    expect(withOidc.oidcEnabled).toBe(true);
    const without = new AuthService(fakePool(), noopLog, cfg("basic"));
    expect(without.oidcEnabled).toBe(false);
  });
});

describe("visibility — private by default, pub is the exception", () => {
  const letter = {
    from_addr: "hermes@house",
    to_addrs: ["you@house"],
    cc_addrs: [],
  };

  it("a participant can see the letter", () => {
    expect(isVisibleTo(letter, "you@house")).toBe(true);
    expect(isVisibleTo(letter, "hermes@house")).toBe(true);
  });

  it("a non-participant cannot see the letter", () => {
    expect(isVisibleTo(letter, "ben@house")).toBe(false);
  });

  it("a letter with pub@house as a participant is public", () => {
    const pub = { ...letter, to_addrs: [PUB_ADDRESS] };
    expect(isPublicLetter(pub)).toBe(true);
    expect(isVisibleTo(pub, "anyone@anywhere")).toBe(true);
  });

  it("a letter from pub@house is public", () => {
    const pub = { ...letter, from_addr: PUB_ADDRESS };
    expect(isPublicLetter(pub)).toBe(true);
    expect(isVisibleTo(pub, "anyone@anywhere")).toBe(true);
  });
});
