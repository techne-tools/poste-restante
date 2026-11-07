/**
 * Key registration over HTTP — SPEC §15: proof of possession, the log line,
 * and the rate limit.
 *
 * The hole this closes: the route was self-only, and it wrote
 * `addresses.identity_id` — the identity spine. A stolen session token (a
 * bearer credential the house hands out) was therefore enough to replace who
 * an address IS: every future letter would be hashed against the attacker's
 * key, and the resident's own signatures would stop resolving.
 *
 * What is locked here, worst case first:
 *   * a registration with no proof is refused AND WRITES NOTHING;
 *   * a correct-looking registration signed by a key that is not the one
 *     being installed is refused and writes nothing (the session-thief);
 *   * a proof harvested for one key record cannot install a different one;
 *   * a nonce minted for another address is refused;
 *   * an expired challenge is refused;
 *   * a good proof installs the key row and then the identity, in that order;
 *   * the change is rate limited, like the password door;
 *   * the log line carries no address, no key and no body — a hashed tag and
 *     a fingerprint suffix only.
 */
import { describe, it, expect } from "vitest";
import { createLetterServer } from "../../src/server.js";
import { KeyProofService } from "../../src/auth/key-proof.js";
import { keyProofMessage } from "../../src/auth/key-proof.js";
import {
  generateAgeIdentity,
  generateEd25519Keypair,
  keyFingerprint,
  signLetterId,
} from "../../src/crypto/keys.js";
import { identityToRecipient } from "age-encryption";
import type { House } from "../../src/house.js";

type LogLine = { level: string; event: string; fields?: Record<string, unknown> };
type Write =
  | { kind: "key"; address: string; keys: { ageRecipient: string; ed25519Public: string } }
  | { kind: "identity"; address: string; identityId: string };

interface KeyRow {
  age_recipient: string;
  ed25519_public: string;
  recovery_age_recipient: string | null;
}

function fakeHouse(seed?: { keys?: KeyRow | null }) {
  const writes: Write[] = [];
  const logs: LogLine[] = [];
  let live: KeyRow | null = seed?.keys ?? null;

  const house = {
    config: {} as never,
    db: {} as never,
    semantic: {} as never,
    embedder: {} as never,
    payloads: undefined,
    log: {
      info: (event: string, fields?: Record<string, unknown>) => logs.push({ level: "info", event, fields }),
      warn: (event: string, fields?: Record<string, unknown>) => logs.push({ level: "warn", event, fields }),
      error: (event: string, fields?: Record<string, unknown>) => logs.push({ level: "error", event, fields }),
    },
    repo: {
      getAddressKey: async () => live,
      setAddressKey: async (
        address: string,
        keys: { ageRecipient: string; ed25519Public: string; recoveryAgeRecipient: string | null },
      ) => {
        writes.push({ kind: "key", address, keys });
        live = {
          age_recipient: keys.ageRecipient,
          ed25519_public: keys.ed25519Public,
          recovery_age_recipient: keys.recoveryAgeRecipient,
        };
      },
      setAddressIdentity: async (address: string, identityId: string) => {
        writes.push({ kind: "identity", address, identityId });
      },
    } as never,
    pipeline: {} as never,
    retrieval: {} as never,
    whisper: {} as never,
    participation: {} as never,
    book: {} as never,
    outbound: null,
    mailbox: null,
    queue: {} as never,
    eventBus: {} as never,
    audio: {} as never,
    transcriber: {} as never,
    close: async () => {},
  } as unknown as House;

  return { house, logs, writes, live: () => live };
}

/** The session credential: a bearer token names the resident. */
const auth = {
  authenticate: async (header?: string) => {
    const match = /^Bearer (\S+)$/.exec(header ?? "");
    return match ? { address: match[1], method: "password" } : null;
  },
} as never;

const bearer = (address: string) => ({ Authorization: `Bearer ${address}` });

/** A resident's fresh material: what the client would mint. */
async function material() {
  const ed = generateEd25519Keypair();
  return {
    ageRecipient: await identityToRecipient(await generateAgeIdentity()),
    ed25519Public: ed.publicKey,
    privateKey: ed.privateKey,
    recoveryAgeRecipient: null as string | null,
  };
}

/** Sign the record for a challenge, as the client's registerKeysWithProof does. */
function signRegistration(
  privateKey: string,
  address: string,
  nonce: string,
  record: { ageRecipient: string; ed25519Public: string; recoveryAgeRecipient: string | null },
): string {
  return signLetterId(keyProofMessage({ address, nonce, ...record }), privateKey);
}

/** Post a registration. Returns the response and the body, if JSON. */
async function register(
  app: ReturnType<typeof createLetterServer>,
  address: string,
  body: unknown,
) {
  const res = await app.request(`/v1/addresses/${encodeURIComponent(address)}/keys`, {
    method: "POST",
    headers: { ...bearer(address), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return { res, json: (await res.json()) as Record<string, any> };
}

/** The full, honest flow: ask for a challenge, sign, register. */
async function challengeFor(app: ReturnType<typeof createLetterServer>, address: string) {
  const res = await app.request(`/v1/addresses/${encodeURIComponent(address)}/keys/challenge`, {
    method: "POST",
    headers: bearer(address),
  });
  expect(res.status).toBe(200);
  return (await res.json()) as { nonce: string; expiresAt: string };
}

describe("key registration — no proof, no write", () => {
  it("refuses a registration that carries no challenge and no signature", async () => {
    const { house, writes } = fakeHouse();
    const app = createLetterServer(house, { auth });
    const keys = await material();

    const { res, json } = await register(app, "chris@house", {
      ageRecipient: keys.ageRecipient,
      ed25519Public: keys.ed25519Public,
    });

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("invalid_keys");
    // The point of the whole item: the identity spine did not move.
    expect(writes).toEqual([]);
  });

  it("refuses a registration signed by a key that is not the one being installed", async () => {
    const { house, writes } = fakeHouse();
    const app = createLetterServer(house, { auth });
    const mine = await material();
    const thief = await material();

    // A session token buys the challenge. It does not buy the private key.
    const { nonce } = await challengeFor(app, "chris@house");
    const signature = signRegistration(thief.privateKey, "chris@house", nonce, mine);

    const { res, json } = await register(app, "chris@house", {
      ageRecipient: mine.ageRecipient,
      ed25519Public: mine.ed25519Public,
      nonce,
      signature,
    });

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("keys_unproven");
    expect(writes).toEqual([]);
  });

  it("refuses a proof harvested for one record when a different record is presented", async () => {
    const { house, writes } = fakeHouse();
    const app = createLetterServer(house, { auth });
    const mine = await material();
    const other = await material();

    const { nonce } = await challengeFor(app, "chris@house");
    const signature = signRegistration(mine.privateKey, "chris@house", nonce, mine);

    const { res, json } = await register(app, "chris@house", {
      // Same resident, same key, different age recipient: the signature
      // covers the whole record, so it no longer covers this one.
      ageRecipient: other.ageRecipient,
      ed25519Public: mine.ed25519Public,
      nonce,
      signature,
    });

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("keys_unproven");
    expect(writes).toEqual([]);
  });

  it("refuses a nonce minted for another address", async () => {
    const { house, writes } = fakeHouse();
    const app = createLetterServer(house, { auth });
    const keys = await material();

    const { nonce } = await challengeFor(app, "sam@house");
    const signature = signRegistration(keys.privateKey, "chris@house", nonce, keys);

    const { res, json } = await register(app, "chris@house", {
      ageRecipient: keys.ageRecipient,
      ed25519Public: keys.ed25519Public,
      nonce,
      signature,
    });

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("keys_unproven");
    expect(writes).toEqual([]);
  });

  it("refuses an expired challenge", async () => {
    const at = { now: 1_700_000_000_000 };
    const keyProof = new KeyProofService({
      secret: Buffer.alloc(32, 3),
      windowMs: 60_000,
      now: () => at.now,
    });
    const { house, writes } = fakeHouse();
    const app = createLetterServer(house, { auth, keyProof });
    const keys = await material();

    const { nonce, expiresAt } = await challengeFor(app, "chris@house");
    const signature = signRegistration(keys.privateKey, "chris@house", nonce, keys);

    // Two windows later — past `expiresAt`.
    at.now = 1_700_000_000_000 + 120_000;
    expect(new Date(expiresAt).getTime()).toBeLessThanOrEqual(at.now);

    const { res, json } = await register(app, "chris@house", {
      ageRecipient: keys.ageRecipient,
      ed25519Public: keys.ed25519Public,
      nonce,
      signature,
    });

    expect(res.status).toBe(400);
    expect(json.error.code).toBe("keys_unproven");
    expect(writes).toEqual([]);
  });

  it("refuses a challenge request for somebody else's address", async () => {
    const { house } = fakeHouse();
    const app = createLetterServer(house, { auth });
    const res = await app.request("/v1/addresses/sam@house/keys/challenge", {
      method: "POST",
      headers: bearer("chris@house"),
    });
    expect(res.status).toBe(403);
  });

  it("refuses a challenge request with no session at all", async () => {
    const { house } = fakeHouse();
    const app = createLetterServer(house, { auth });
    const res = await app.request("/v1/addresses/chris@house/keys/challenge", { method: "POST" });
    expect(res.status).toBe(401);
  });
});

describe("key registration — a good proof installs the key, then the identity", () => {
  it("writes the key row and then the identity, in that order", async () => {
    const { house, writes, live } = fakeHouse();
    const app = createLetterServer(house, { auth });
    const keys = await material();

    const { nonce } = await challengeFor(app, "chris@house");
    const signature = signRegistration(keys.privateKey, "chris@house", nonce, keys);
    const { res, json } = await register(app, "chris@house", {
      ageRecipient: keys.ageRecipient,
      ed25519Public: keys.ed25519Public,
      nonce,
      signature,
    });

    expect(res.status).toBe(201);
    expect(json.ed25519_public).toBe(keys.ed25519Public);
    expect(writes.map((w) => w.kind)).toEqual(["key", "identity"]);
    expect(live()?.ed25519_public).toBe(keys.ed25519Public);
  });

  it("accepts a re-registration of the same key (idempotent)", async () => {
    const { house, writes } = fakeHouse();
    const app = createLetterServer(house, { auth });
    const keys = await material();

    for (let i = 0; i < 2; i += 1) {
      const { nonce } = await challengeFor(app, "chris@house");
      const signature = signRegistration(keys.privateKey, "chris@house", nonce, keys);
      const { res } = await register(app, "chris@house", {
        ageRecipient: keys.ageRecipient,
        ed25519Public: keys.ed25519Public,
        nonce,
        signature,
      });
      expect(res.status).toBe(201);
    }
    // Two writes per registration: the repo decides whether the key row is
    // a new generation or a no-op (030's history semantics).
    expect(writes).toHaveLength(4);
  });
});

describe("key registration — the change is logged without naming anybody", () => {
  it("logs a hashed address tag and fingerprint suffixes, never the address", async () => {
    const { house, logs } = fakeHouse();
    const app = createLetterServer(house, { auth });
    const keys = await material();

    const { nonce } = await challengeFor(app, "chris@house");
    const signature = signRegistration(keys.privateKey, "chris@house", nonce, keys);
    await register(app, "chris@house", {
      ageRecipient: keys.ageRecipient,
      ed25519Public: keys.ed25519Public,
      nonce,
      signature,
    });

    const registered = logs.find((l) => l.event === "keys:registered");
    expect(registered).toBeDefined();
    expect(registered?.fields).toMatchObject({
      addressTag: expect.stringMatching(/^[0-9a-f]{12}$/),
      from: null,
      to: keyFingerprint(keys.ed25519Public).slice(0, 8),
    });
    // The privacy rule: nothing in the log can be read back into a person
    // or a key. Not the address, not the key, not the recipient.
    const serialised = JSON.stringify(logs);
    expect(serialised).not.toContain("chris@house");
    expect(serialised).not.toContain(keys.ed25519Public);
    expect(serialised).not.toContain(keys.ageRecipient);
  });

  it("logs a rotation as from one fingerprint to another", async () => {
    const old = await material();
    const { house, logs } = fakeHouse({
      keys: {
        age_recipient: old.ageRecipient,
        ed25519_public: old.ed25519Public,
        recovery_age_recipient: null,
      },
    });
    const app = createLetterServer(house, { auth });
    const next = await material();

    const { nonce } = await challengeFor(app, "chris@house");
    const signature = signRegistration(next.privateKey, "chris@house", nonce, next);
    await register(app, "chris@house", {
      ageRecipient: next.ageRecipient,
      ed25519Public: next.ed25519Public,
      nonce,
      signature,
    });

    const rotated = logs.find((l) => l.event === "keys:rotated");
    expect(rotated?.fields).toMatchObject({
      from: keyFingerprint(old.ed25519Public).slice(0, 8),
      to: keyFingerprint(next.ed25519Public).slice(0, 8),
    });
    expect(JSON.stringify(logs)).not.toContain("chris@house");
  });

  it("writes no line for a no-op re-registration — nothing changed", async () => {
    const keys = await material();
    const { house, logs } = fakeHouse({
      keys: {
        age_recipient: keys.ageRecipient,
        ed25519_public: keys.ed25519Public,
        recovery_age_recipient: null,
      },
    });
    const app = createLetterServer(house, { auth });

    const { nonce } = await challengeFor(app, "chris@house");
    const signature = signRegistration(keys.privateKey, "chris@house", nonce, keys);
    await register(app, "chris@house", {
      ageRecipient: keys.ageRecipient,
      ed25519Public: keys.ed25519Public,
      nonce,
      signature,
    });

    expect(logs.filter((l) => l.event.startsWith("keys:"))).toEqual([]);
  });

  it("logs a refused proof — but not the attempt's signature or key", async () => {
    const { house, logs } = fakeHouse();
    const app = createLetterServer(house, { auth });
    const mine = await material();
    const thief = await material();

    const { nonce } = await challengeFor(app, "chris@house");
    const signature = signRegistration(thief.privateKey, "chris@house", nonce, mine);
    await register(app, "chris@house", {
      ageRecipient: mine.ageRecipient,
      ed25519Public: mine.ed25519Public,
      nonce,
      signature,
    });

    const refused = logs.find((l) => l.event === "keys:proof-refused");
    expect(refused?.fields).toMatchObject({
      addressTag: expect.stringMatching(/^[0-9a-f]{12}$/),
      reason: "bad_signature",
    });
    const serialised = JSON.stringify(logs);
    expect(serialised).not.toContain("chris@house");
    expect(serialised).not.toContain(signature);
  });
});

describe("key registration — rate limited like the password door", () => {
  it("answers 429 after ten attempts in the window", async () => {
    const { house } = fakeHouse();
    const app = createLetterServer(house, { auth });
    const keys = await material();

    // Ten malformed registrations: the limiter counts the door, not the
    // success. Each is refused for shape, which is enough to be a hit.
    const statuses: number[] = [];
    for (let i = 0; i < 11; i += 1) {
      const { res } = await register(app, "chris@house", {
        ageRecipient: keys.ageRecipient,
        ed25519Public: keys.ed25519Public,
      });
      statuses.push(res.status);
    }
    expect(statuses.slice(0, 10).every((s) => s === 400)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});
