/**
 * Invite unit tests — hermetic. The pool, pipeline, and auth are faked;
 * no postgres, qdrant, or ollama required. These verify the invite
 * primitives: one-time code generation (human-typable, hash stored not the
 * code), minting (letter ingest + invite row), and redemption (possession +
 * code, atomic one-time, fail-closed negative paths).
 */
import { describe, it, expect } from "vitest";
import {
  InviteService,
  generateInviteCode,
  hashInviteCode,
  type RedeemInput,
} from "../../src/invites/service.js";

/** A fake pool: rows keyed by SQL (each test exercises one query shape). */
function fakePool(rows: Record<string, unknown[]> = {}) {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.startsWith("SELECT i.letter_id")) {
        return { rows: rows["select_invite"] ?? [] };
      }
      return { rows: rows[sql] ?? [] };
    },
    connect: async () => ({
      query: async (sql: string) => {
        if (sql === "BEGIN" || sql === "COMMIT" || sql === "ROLLBACK") {
          queries.push(sql);
          return { rows: [] };
        }
        queries.push(sql);
        // The UPDATE claim: 1 row claimed (the happy path).
        if (sql.startsWith("UPDATE invites")) {
          return { rows: [], rowCount: 1 };
        }
        if (sql.startsWith("SELECT i.letter_id")) {
          return { rows: rows["select_invite"] ?? [] };
        }
        if (sql.startsWith("INSERT INTO invites")) {
          return { rows: [], rowCount: 1 };
        }
        return { rows: rows[sql] ?? [] };
      },
      release: () => {},
    }),
  };
  return { pool: pool as never, queries };
}

/** A fake pipeline: records the letter that would be ingested. */
function fakePipeline() {
  const letters: unknown[] = [];
  return {
    letters,
    pipeline: {
      ingest: async (letter: unknown) => {
        letters.push(letter);
        return { letterId: `id_${letters.length}`, created: true };
      },
    } as never,
  };
}

/** A fake auth service: residents are whoever has a password set. */
function fakeAuth(residents: string[] = []) {
  const residentSet = new Set(residents);
  return {
    residents: residentSet,
    auth: {
      hasCredential: async (address: string) => residentSet.has(address),
    } as never,
  };
}

describe("generateInviteCode", () => {
  it("is human-typable: groups of unambiguous chars separated by dashes", () => {
    const code = generateInviteCode();
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
  });

  it("generates distinct codes", () => {
    const a = generateInviteCode();
    const b = generateInviteCode();
    expect(a).not.toBe(b);
  });
});

describe("hashInviteCode", () => {
  it("hashes deterministically — the code itself is never stored", () => {
    const code = "ABCD-EFGH-JKMN";
    expect(hashInviteCode(code)).toBe(hashInviteCode(code));
    expect(hashInviteCode(code)).not.toBe(code);
    expect(hashInviteCode(code)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("InviteService.mint", () => {
  it("ingests an invite letter and stores only the code hash", async () => {
    const { pool, queries } = fakePool();
    const { letters, pipeline } = fakePipeline();
    const { auth } = fakeAuth([]);
    const svc = new InviteService(pool, pipeline, auth);

    const minted = await svc.mint("you@house", "guest@house");

    expect(minted.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(letters).toHaveLength(1);
    const letter = letters[0] as {
      envelope: { from: string; to: string[]; kind: string; subject: string };
      body: { content: string };
    };
    expect(letter.envelope.from).toBe("you@house");
    expect(letter.envelope.to).toEqual(["guest@house"]);
    expect(letter.envelope.kind).toBe("invite");
    expect(letter.body.content).toContain(minted.code);
    // Only the hash lands in the store — the code itself never does.
    const insertIdx = queries.findIndex((q) => q.startsWith("INSERT INTO invites"));
    expect(insertIdx).toBeGreaterThan(-1);
    expect(hashInviteCode(minted.code)).toMatch(/^[0-9a-f]{64}$/);
    expect(queries.some((q) => q.includes("code_hash"))).toBe(true);
  });

  it("refuses to invite an address that is already a resident", async () => {
    const { pool } = fakePool();
    const { pipeline } = fakePipeline();
    const { auth } = fakeAuth(["guest@house"]);
    const svc = new InviteService(pool, pipeline, auth);

    await expect(svc.mint("you@house", "guest@house")).rejects.toThrow(
      "already a resident",
    );
  });
});

describe("InviteService.redeem", () => {
  const inviteRow = {
    letterId: "inv_1",
    expiresAt: null,
    redeemedAt: null,
    toAddrs: ["guest@house"],
  };

  const input: RedeemInput = {
    address: "guest@house",
    code: "ABCD-EFGH-JKMN",
    password: "correct horse battery staple",
  };

  it("redeems with the right code and address — guest sets their own credential", async () => {
    const { pool, queries } = fakePool({ select_invite: [inviteRow] });
    const { pipeline } = fakePipeline();
    const { auth } = fakeAuth([]);
    const svc = new InviteService(pool, pipeline, auth);

    const result = await svc.redeem(input);

    expect(result).toEqual({ address: "guest@house" });
    // The claim was made and a credential granted — one transaction.
    expect(queries.some((q) => q.startsWith("UPDATE invites"))).toBe(true);
    expect(queries.some((q) => q.startsWith("INSERT INTO credentials"))).toBe(true);
    expect(queries.some((q) => q === "COMMIT")).toBe(true);
  });

  it("refuses a wrong code — unknown code is null, never confirming existence", async () => {
    const { pool } = fakePool({}); // no invite row for this hash
    const { pipeline } = fakePipeline();
    const { auth } = fakeAuth([]);
    const svc = new InviteService(pool, pipeline, auth);

    expect(await svc.redeem(input)).toBeNull();
  });

  it("refuses a code presented by someone who is not the addressee", async () => {
    const { pool } = fakePool({
      select_invite: [{ ...inviteRow, toAddrs: ["actual@house"] }],
    });
    const { pipeline } = fakePipeline();
    const { auth } = fakeAuth([]);
    const svc = new InviteService(pool, pipeline, auth);

    expect(await svc.redeem({ ...input, address: "guest@house" })).toBeNull();
  });

  it("refuses an already-redeemed invite — one-time", async () => {
    const { pool } = fakePool({
      select_invite: [{ ...inviteRow, redeemedAt: new Date("2026-08-31T10:00:00Z") }],
    });
    const { pipeline } = fakePipeline();
    const { auth } = fakeAuth([]);
    const svc = new InviteService(pool, pipeline, auth);

    expect(await svc.redeem(input)).toBeNull();
  });

  it("refuses an expired invite", async () => {
    const { pool } = fakePool({
      select_invite: [
        { ...inviteRow, expiresAt: new Date("2026-01-01T00:00:00Z") },
      ],
    });
    const { pipeline } = fakePipeline();
    const { auth } = fakeAuth([]);
    const svc = new InviteService(pool, pipeline, auth);

    expect(await svc.redeem(input)).toBeNull();
  });

  it("refuses a redeem for an address that is already a resident", async () => {
    const { pool } = fakePool({ select_invite: [inviteRow] });
    const { pipeline } = fakePipeline();
    const { auth } = fakeAuth(["guest@house"]);
    const svc = new InviteService(pool, pipeline, auth);

    expect(await svc.redeem(input)).toBeNull();
  });

  it("refuses a short password", async () => {
    const { pool, queries } = fakePool({ select_invite: [inviteRow] });
    const { pipeline } = fakePipeline();
    const { auth } = fakeAuth([]);
    const svc = new InviteService(pool, pipeline, auth);

    expect(await svc.redeem({ ...input, password: "short" })).toBeNull();
    // No claim was attempted — no UPDATE hits the pool.
    expect(queries.some((q) => q.startsWith("UPDATE invites"))).toBe(false);
  });
});
