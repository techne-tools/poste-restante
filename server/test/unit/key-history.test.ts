/**
 * Key history — SPEC §15, hermetic unit tests.
 *
 * Two load-bearing properties, no infrastructure required:
 *
 *   1. A sealed letter's signature names the id it was made over. After the
 *      sender rotates, the live key no longer reproduces that id — so
 *      `resolveSignedId` walks the sender's key history and recovers it. That
 *      is what stops a rotation from rejecting (or duplicating) a letter that
 *      was already written.
 *   2. `setAddressKey` CLOSES the live row (`retired_at`) and appends the
 *      next. It never overwrites, and re-registering the same key writes
 *      nothing at all.
 *
 * The integration suite (`test/integration/key-history.test.ts`) proves the
 * same properties against postgres, where the partial unique index lives.
 */
import { describe, it, expect } from "vitest";
import { resolveSignedId, canonicaliseWith, letterIdFromCanonical } from "../../src/id.js";
import { generateEd25519Keypair, signLetterId, verifyLetterId } from "../../src/crypto/keys.js";
import { PostgresRepository } from "../../src/db/repository.js";
import type { Letter, SealedLetterBody } from "../../src/types.js";

const CIPHERTEXT = "-----BEGIN AGE ENCRYPTED FILE-----\nnot really\n-----END AGE ENCRYPTED FILE-----";

/** A sealed letter — the body narrowed so the signature is addressable. */
type SealedLetter = Letter & { body: SealedLetterBody };

const mkSealed = (from: string, to: string[]): SealedLetter => ({
  envelope: { from, to, cc: [], thread: "th_key_history", kind: "letter", lang: "en-AU", subject: "" },
  time: { gregorian: "2026-11-08T09:00:00Z", frames: [] },
  body: { format: "sealed", content: CIPHERTEXT, recipients: [], signature: "" },
});

const idOf = (letter: Letter, identities: Map<string, string>) =>
  letterIdFromCanonical(canonicaliseWith(letter, identities));

describe("resolveSignedId — the id a sealed letter was signed under", () => {
  it("recovers the pre-rotation id from the sender's key history", () => {
    const retired = generateEd25519Keypair();
    const live = generateEd25519Keypair();
    const letter = mkSealed("ben@house", ["you@house"]);

    // Written while `retired` was ben's live key.
    const identitiesThen = new Map([
      ["ben@house", retired.publicKey],
      ["you@house", "you-fingerprint"],
    ]);
    const signedId = idOf(letter, identitiesThen);
    letter.body.signature = signLetterId(signedId, retired.privateKey);

    // Delivered after the rotation: ben's live key is now `live`, and the
    // history (newest first) still carries the retired one.
    const identitiesNow = new Map([
      ["ben@house", live.publicKey],
      ["you@house", "you-fingerprint"],
    ]);
    const resolved = resolveSignedId(
      letter,
      identitiesNow,
      [live.publicKey, retired.publicKey],
      letter.body.signature,
      verifyLetterId,
    );

    expect(resolved).toBe(signedId);
    // The live key alone would have produced a different id — the defect.
    expect(idOf(letter, identitiesNow)).not.toBe(signedId);
  });

  it("tries the live key first — a current letter keeps the current id", () => {
    const retired = generateEd25519Keypair();
    const live = generateEd25519Keypair();
    const letter = mkSealed("ben@house", ["you@house"]);
    const identitiesNow = new Map([["ben@house", live.publicKey]]);
    const currentId = idOf(letter, identitiesNow);
    letter.body.signature = signLetterId(currentId, live.privateKey);

    const resolved = resolveSignedId(
      letter,
      identitiesNow,
      [live.publicKey, retired.publicKey],
      letter.body.signature,
      verifyLetterId,
    );
    expect(resolved).toBe(currentId);
  });

  it("resolves a self-addressed letter consistently across from and to", () => {
    // The override is per handle, not per position: ben writing to himself
    // resolves to the same identity in both slots, exactly as it did before
    // the rotation. This is the shape most of the sealed tests use.
    const retired = generateEd25519Keypair();
    const live = generateEd25519Keypair();
    const letter = mkSealed("ben@house", ["ben@house"]);

    const identitiesThen = new Map([["ben@house", retired.publicKey]]);
    const signedId = idOf(letter, identitiesThen);
    letter.body.signature = signLetterId(signedId, retired.privateKey);

    const identitiesNow = new Map([["ben@house", live.publicKey]]);
    expect(
      resolveSignedId(
        letter,
        identitiesNow,
        [live.publicKey, retired.publicKey],
        letter.body.signature,
        verifyLetterId,
      ),
    ).toBe(signedId);
  });

  it("returns null when no key the sender has held verifies", () => {
    const stranger = generateEd25519Keypair();
    const live = generateEd25519Keypair();
    const letter = mkSealed("ben@house", ["you@house"]);
    letter.body.signature = signLetterId("some-other-id", stranger.privateKey);

    expect(
      resolveSignedId(
        letter,
        new Map([["ben@house", live.publicKey]]),
        [live.publicKey],
        letter.body.signature,
        verifyLetterId,
      ),
    ).toBeNull();
  });

  it("returns null for a keyless legacy sender — nothing to verify with", () => {
    const letter = mkSealed("legacy@house", ["you@house"]);
    letter.body.signature = "not-a-real-signature";
    expect(resolveSignedId(letter, new Map(), [], letter.body.signature, verifyLetterId)).toBeNull();
  });

  it("cannot recover a letter after a RECIPIENT has rotated — the recorded v1 limit", () => {
    // Documented, not overlooked: only the sender's history is walked, so a
    // rotation by any other party to the letter leaves the signed id
    // unreachable. Such a letter was never stored — re-seal and re-sign.
    const benThen = generateEd25519Keypair();
    const benNow = generateEd25519Keypair();
    const youThen = generateEd25519Keypair();
    const youNow = generateEd25519Keypair();
    const letter = mkSealed("ben@house", ["you@house"]);

    const signedId = idOf(
      letter,
      new Map([
        ["ben@house", benThen.publicKey],
        ["you@house", youThen.publicKey],
      ]),
    );
    letter.body.signature = signLetterId(signedId, benThen.privateKey);

    const identitiesNow = new Map([
      ["ben@house", benNow.publicKey],
      ["you@house", youNow.publicKey],
    ]);
    expect(
      resolveSignedId(
        letter,
        identitiesNow,
        [benNow.publicKey, benThen.publicKey],
        letter.body.signature,
        verifyLetterId,
      ),
    ).toBeNull();
  });
});

describe("setAddressKey — close the live row, append the next", () => {
  type Live = {
    id: string;
    age_recipient: string;
    ed25519_public: string;
    recovery_age_recipient: string | null;
  };

  function fakePool(live: Live | null) {
    const calls: { sql: string; params?: unknown[] }[] = [];
    let released = 0;
    const client = {
      query: async (sql: string, params?: unknown[]) => {
        calls.push({ sql, params });
        if (sql.includes("FROM address_keys")) return { rows: live ? [live] : [] };
        return { rows: [] };
      },
      release: () => {
        released += 1;
      },
    };
    const pool = { connect: async () => client };
    return {
      repo: new PostgresRepository(pool as never),
      calls,
      released: () => released,
    };
  }

  const live = (over: Partial<Live> = {}): Live => ({
    id: "7",
    age_recipient: "age-old",
    ed25519_public: "ed-old",
    recovery_age_recipient: null,
    ...over,
  });

  it("retires the live row and inserts the next, in one transaction", async () => {
    const { repo, calls, released } = fakePool(live());
    await repo.setAddressKey("ben@house", {
      ageRecipient: "age-new",
      ed25519Public: "ed-new",
      recoveryAgeRecipient: null,
    });

    expect(calls.map((c) => c.sql.split("\n")[0].trim())).toEqual([
      "BEGIN",
      "SELECT id, age_recipient, ed25519_public, recovery_age_recipient",
      "UPDATE address_keys SET retired_at = now() WHERE id = $1",
      "INSERT INTO address_keys (address, age_recipient, ed25519_public, recovery_age_recipient)",
      "COMMIT",
    ]);
    // The retired generation is named by id — not by address, and not by a
    // rewrite of the key columns.
    expect(calls[2].params).toEqual(["7"]);
    // The appended row is live by construction (no retired_at is written).
    expect(calls[3].sql).not.toContain("retired_at");
    expect(calls[3].params).toEqual(["ben@house", "age-new", "ed-new", null]);
    // Nothing overwrites or reopens a retired row.
    expect(calls.some((c) => /DO UPDATE|ON CONFLICT/i.test(c.sql))).toBe(false);
    expect(released()).toBe(1);
  });

  it("writes nothing when the same key is registered again", async () => {
    const { repo, calls } = fakePool(live());
    await repo.setAddressKey("ben@house", {
      ageRecipient: "age-old",
      ed25519Public: "ed-old",
      recoveryAgeRecipient: null,
    });
    expect(calls.map((c) => c.sql.split("\n")[0].trim())).toEqual([
      "BEGIN",
      "SELECT id, age_recipient, ed25519_public, recovery_age_recipient",
      "COMMIT",
    ]);
  });

  it("appends the first generation for a keyless address", async () => {
    const { repo, calls } = fakePool(null);
    await repo.setAddressKey("you@house", {
      ageRecipient: "age-1",
      ed25519Public: "ed-1",
      recoveryAgeRecipient: "recovery-1",
    });
    const sqls = calls.map((c) => c.sql.split("\n")[0].trim());
    expect(sqls[0]).toBe("BEGIN");
    expect(sqls).toContain("INSERT INTO address_keys (address, age_recipient, ed25519_public, recovery_age_recipient)");
    expect(sqls.some((s) => s.startsWith("UPDATE address_keys"))).toBe(false);
    expect(calls[2].params).toEqual(["you@house", "age-1", "ed-1", "recovery-1"]);
  });
});
