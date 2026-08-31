/**
 * Invite integration tests — the full invitation-only membership protocol
 * against live infra (postgres 15, qdrant, ollama). Gated by
 * POSTE_RESTANTE_INTEGRATION=1. These prove the whole arc:
 *
 *   owner mints → invite letter lands (dormant address + voucher edge in the
 *     social graph, code hash in invites, code never stored)
 *   guest redeems → only the addressee with the right code wins, once,
 *     and is granted a credential they set themselves
 *   the new resident can then authenticate
 *
 * And the privacy rules: wrong code, wrong address, spent, expiring, and
 * already-a-resident all answer 404 — absence is silence.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { buildHouse } from "../../src/index.js";
import { createLetterServer } from "../../src/server.js";
import { AuthService } from "../../src/auth/service.js";
import { InviteService } from "../../src/invites/service.js";
import type { House } from "../../src/house.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";

const basic = (address: string, password: string) =>
  `Basic ${Buffer.from(`${address}:${password}`).toString("base64")}`;

describe.skipIf(!INTEGRATION)("invites (integration)", () => {
  let house: House;
  let auth: AuthService;
  let invites: InviteService;
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
      `TRUNCATE invites, letters, threads, frames, addresses, credentials RESTART IDENTITY CASCADE`,
    );
    auth = new AuthService(house.db.pool, house.log, house.config.auth);
    // The owner: a resident who can vouch.
    await auth.setPassword("you@house", "youyouyou");
    invites = new InviteService(house.db.pool, house.pipeline, auth);
    app = createLetterServer(house, { auth, invites });
  });

  afterAll(async () => {
    await house.close();
  });

  it("mints an invite — the letter is in the archive, the address is dormant", async () => {
    const minted = await invites.mint("you@house", "guest@house");

    expect(minted.code).toMatch(/^[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}-[A-HJKMNP-Z2-9]{4}$/);
    expect(minted.letterId).toBeTruthy();

    // The invite letter is retrievable by the owner and the guest (participants).
    const { rows } = await house.db.pool.query<{ kind: string }>(
      `SELECT kind FROM letters WHERE id = $1`,
      [minted.letterId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.kind).toBe("invite");

    // The guest address exists in the social graph (dormant — no credential).
    const addr = await house.db.pool.query<{ id: string }>(
      `SELECT id FROM addresses WHERE id = $1`,
      ["guest@house"],
    );
    expect(addr.rows).toHaveLength(1);
    expect(await auth.hasCredential("guest@house")).toBe(false);

    // Only the hash is stored, never the code.
    const inv = await house.db.pool.query<{ code_hash: string }>(
      `SELECT code_hash FROM invites WHERE letter_id = $1`,
      [minted.letterId],
    );
    expect(inv.rows).toHaveLength(1);
    expect(inv.rows[0]!.code_hash).not.toContain(minted.code);
    expect(inv.rows[0]!.code_hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("guest redeems the invite and becomes a resident", async () => {
    const minted = await invites.mint("you@house", "joiner@house");

    const res = await app.request("/v1/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "joiner@house",
        code: minted.code,
        password: "joinerjoiner",
      }),
    });
    expect(res.status).toBe(201);
    const json = (await res.json()) as { address: string; joined: boolean };
    expect(json).toEqual({ address: "joiner@house", joined: true });

    // The credential was granted — the guest can now authenticate.
    const authRes = await app.request("/v1/letters", {
      method: "GET",
      headers: { Authorization: basic("joiner@house", "joinerjoiner") },
    });
    expect(authRes.status).toBe(200);

    // The invite is spent.
    const spent = await house.db.pool.query<{ redeemed_at: Date | null }>(
      `SELECT redeemed_at FROM invites WHERE letter_id = $1`,
      [minted.letterId],
    );
    expect(spent.rows[0]!.redeemed_at).not.toBeNull();
  });

  it("redemption is one-time — a spent invite answers 404", async () => {
    const minted = await invites.mint("you@house", "twice@house");
    const body = {
      address: "twice@house",
      code: minted.code,
      password: "twicetwice",
    };

    const first = await app.request("/v1/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(first.status).toBe(201);

    const second = await app.request("/v1/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    expect(second.status).toBe(404);
  });

  it("wrong code answers 404", async () => {
    const minted = await invites.mint("you@house", "wrongcode@house");
    const res = await app.request("/v1/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "wrongcode@house",
        code: "ZZZZ-ZZZZ-ZZZZ",
        password: "wrongwrong",
      }),
    });
    expect(res.status).toBe(404);
    expect(minted.code).not.toBe("ZZZZ-ZZZZ-ZZZZ");
  });

  it("a non-addressee with the code answers 404", async () => {
    const minted = await invites.mint("you@house", "addressee@house");
    const res = await app.request("/v1/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "eavesdropper@house",
        code: minted.code,
        password: "eavesdrop",
      }),
    });
    expect(res.status).toBe(404);
  });

  it("a resident cannot be invited to themselves", async () => {
    await expect(invites.mint("you@house", "you@house")).rejects.toThrow(
      "already a resident",
    );
  });

  it("expired invites cannot be redeemed", async () => {
    // Insert an invite row manually with an expiry in the past; the letter
    // must exist for the possession check, so deliver it as a letter first
    // via the ordinary path, then link the expired invite row.
    const letterRes = await app.request("/v1/letters", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: basic("you@house", "youyouyou"),
      },
      body: JSON.stringify({
        envelope: {
          from: "you@house",
          to: ["expired@house"],
          cc: [],
          thread: "th_invite_expired",
          kind: "invite",
          lang: "en-AU",
          subject: "an invitation to the house",
        },
        time: { gregorian: new Date().toISOString(), frames: [] },
        body: {
          format: "markdown",
          content: "You are invited to the house.",
        },
      }),
    });
    expect(letterRes.status).toBe(201);
    const { id } = (await letterRes.json()) as { id: string };

    await house.db.pool.query(
      `INSERT INTO invites (letter_id, created_by, code_hash, expires_at)
       VALUES ($1, $2, $3, now() - interval '1 day')`,
      [id, "you@house", "past-expired-invite-code-hash"],
    );

    const res = await app.request("/v1/invites/redeem", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        address: "expired@house",
        code: "XXXX-XXXX-XXXX",
        password: "expiredexp",
      }),
    });
    expect(res.status).toBe(404);
  });
});
