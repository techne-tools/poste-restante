/**
 * Proof of possession for key registration — SPEC §15.
 *
 * The hole this closes: `POST /v1/addresses/:id/keys` was self-only, but it
 * also writes `addresses.identity_id`. A stolen session token could replace
 * the address's identity — the key every future letter is hashed against.
 * A registration now has to show it holds the private half of the key it is
 * installing.
 *
 * What is locked here:
 *   * the signed message is a fixed literal (the client mirrors it, and a
 *     drift on either side must fail loudly);
 *   * a nonce is only good for the address it was issued to, and only
 *     inside its window (with the previous window accepted, so a challenge
 *     issued a second before a boundary still works);
 *   * the proof binds the WHOLE record — a signature harvested from one
 *     registration cannot install different keys.
 */
import { describe, it, expect } from "vitest";
import {
  KEY_PROOF_WINDOW_MS,
  KeyProofService,
  keyProofMessage,
} from "../../src/auth/key-proof.js";
import { generateAgeIdentity, generateEd25519Keypair, signLetterId } from "../../src/crypto/keys.js";
import { identityToRecipient } from "age-encryption";

/** A clock we drive by hand — the window logic is the test. */
const T0 = 1_700_000_000_000;

function service(at: { now: number }, windowMs = KEY_PROOF_WINDOW_MS) {
  return new KeyProofService({
    secret: Buffer.alloc(32, 7),
    windowMs,
    now: () => at.now,
  });
}

async function registration() {
  const ed = generateEd25519Keypair();
  const ageRecipient = await identityToRecipient(await generateAgeIdentity());
  return {
    record: {
      ageRecipient,
      ed25519Public: ed.publicKey,
      recoveryAgeRecipient: null,
    },
    privateKey: ed.privateKey,
  };
}

/** Sign the message the server will check, exactly as a client must. */
function prove(
  privateKey: string,
  input: {
    address: string;
    nonce: string;
    ageRecipient: string;
    ed25519Public: string;
    recoveryAgeRecipient: string | null;
  },
): string {
  return signLetterId(keyProofMessage(input), privateKey);
}

describe("the signed message — a fixed literal, mirrored by the client", () => {
  it("is six lines, fixed order, empty line for an absent recovery recipient", () => {
    expect(
      keyProofMessage({
        address: "chris@house",
        nonce: "1700000000.abc",
        ageRecipient: "age1qqq",
        ed25519Public: "AAAA",
        recoveryAgeRecipient: null,
      }),
    ).toBe("poste-restante:key-proof:v1\nchris@house\n1700000000.abc\nage1qqq\nAAAA\n");
  });

  it("carries the recovery recipient when there is one, on the last line", () => {
    expect(
      keyProofMessage({
        address: "chris@house",
        nonce: "n",
        ageRecipient: "age1a",
        ed25519Public: "B",
        recoveryAgeRecipient: "age1r",
      }),
    ).toBe("poste-restante:key-proof:v1\nchris@house\nn\nage1a\nB\nage1r");
  });
});

describe("the nonce — issued for one address, good for one window", () => {
  it("accepts the proof it issued", async () => {
    const at = { now: T0 };
    const keys = service(at);
    const { record, privateKey } = await registration();
    const { nonce, expiresAt } = keys.issue("chris@house");

    expect(new Date(expiresAt).getTime()).toBeGreaterThan(at.now);
    const signature = prove(privateKey, { address: "chris@house", nonce, ...record });
    expect(keys.verify("chris@house", record, nonce, signature)).toEqual({ ok: true });
  });

  it("refuses a nonce issued to somebody else", async () => {
    const at = { now: T0 };
    const keys = service(at);
    const { record, privateKey } = await registration();
    const { nonce } = keys.issue("chris@house");
    const signature = prove(privateKey, { address: "chris@house", nonce, ...record });

    // The nonce is bound to the address it was issued for, so it cannot be
    // carried to another registration even with a valid signature.
    expect(keys.verify("sam@house", record, nonce, signature)).toEqual({
      ok: false,
      reason: "bad_nonce",
    });
  });

  it("refuses a nonce whose mac was rewritten", async () => {
    const at = { now: T0 };
    const keys = service(at);
    const { record, privateKey } = await registration();
    const { nonce } = keys.issue("chris@house");
    const [bucket] = nonce.split(".");
    const forged = `${bucket}.${"A".repeat(43)}`;
    const signature = prove(privateKey, { address: "chris@house", nonce: forged, ...record });

    expect(keys.verify("chris@house", record, forged, signature)).toEqual({
      ok: false,
      reason: "bad_nonce",
    });
  });

  it("refuses a nonce that is not a nonce", async () => {
    const at = { now: T0 };
    const keys = service(at);
    const { record, privateKey } = await registration();
    for (const junk of ["", "abc", ".abc", "123."]) {
      const signature = prove(privateKey, { address: "chris@house", nonce: junk, ...record });
      expect(keys.verify("chris@house", record, junk, signature).ok, junk).toBe(false);
    }
  });

  it("still accepts a challenge issued in the previous window — a boundary must not expire mid-signature", async () => {
    const at = { now: T0 };
    const keys = service(at, 60_000);
    const { record, privateKey } = await registration();
    const { nonce } = keys.issue("chris@house");

    // One whole window later: the challenge is in the previous window.
    at.now = T0 + 60_000;
    const signature = prove(privateKey, { address: "chris@house", nonce, ...record });
    expect(keys.verify("chris@house", record, nonce, signature)).toEqual({ ok: true });
  });

  it("refuses a challenge two windows old", async () => {
    const at = { now: T0 };
    const keys = service(at, 60_000);
    const { record, privateKey } = await registration();
    const { nonce } = keys.issue("chris@house");

    at.now = T0 + 120_000;
    const signature = prove(privateKey, { address: "chris@house", nonce, ...record });
    expect(keys.verify("chris@house", record, nonce, signature)).toEqual({
      ok: false,
      reason: "expired",
    });
  });
});

describe("the proof — possession of the key being installed, over that key's record", () => {
  it("refuses a signature made by a different key", async () => {
    const at = { now: T0 };
    const keys = service(at);
    const { record } = await registration();
    const attacker = generateEd25519Keypair();
    const { nonce } = keys.issue("chris@house");
    // The attacker signs correctly — with a key that is not the one the
    // registration proposes. That is exactly the session-thief's position.
    const signature = prove(attacker.privateKey, {
      address: "chris@house",
      nonce,
      ...record,
    });
    expect(keys.verify("chris@house", record, nonce, signature)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a proof for one key record presented with another", async () => {
    const at = { now: T0 };
    const keys = service(at);
    const mine = await registration();
    const other = await registration();
    const { nonce } = keys.issue("chris@house");
    const signature = prove(mine.privateKey, { address: "chris@house", nonce, ...mine.record });

    // Same signer, different age recipient: the message binds the whole
    // record, so the signature no longer covers what is being installed.
    expect(
      keys.verify("chris@house", { ...mine.record, ageRecipient: other.record.ageRecipient }, nonce, signature),
    ).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("refuses a signature over a different address", async () => {
    const at = { now: T0 };
    const keys = service(at);
    const { record, privateKey } = await registration();
    const { nonce } = keys.issue("chris@house");
    const signature = prove(privateKey, { address: "sam@house", nonce, ...record });
    expect(keys.verify("chris@house", record, nonce, signature)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a signature over a different nonce", async () => {
    const at = { now: T0 };
    const keys = service(at, 60_000);
    const { record, privateKey } = await registration();
    const { nonce } = keys.issue("chris@house");
    const signature = prove(privateKey, { address: "chris@house", nonce, ...record });

    // A challenge issued in a later window carries a different nonce. The
    // old signature does not cover it, even though both nonces are ours and
    // both are in date when presented.
    at.now = T0 + 60_000;
    const { nonce: later } = keys.issue("chris@house");
    expect(later).not.toBe(nonce);
    expect(keys.verify("chris@house", record, later, signature)).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("refuses a malformed signature rather than throwing", async () => {
    const at = { now: T0 };
    const keys = service(at);
    const { record } = await registration();
    const { nonce } = keys.issue("chris@house");
    expect(keys.verify("chris@house", record, nonce, "not-a-signature")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
    expect(keys.verify("chris@house", record, nonce, "")).toEqual({
      ok: false,
      reason: "bad_signature",
    });
  });

  it("a service with another secret refuses this service's challenges", async () => {
    const at = { now: T0 };
    const mine = service(at);
    const theirs = new KeyProofService({
      secret: Buffer.alloc(32, 9),
      windowMs: KEY_PROOF_WINDOW_MS,
      now: () => at.now,
    });
    const { record, privateKey } = await registration();
    const { nonce } = mine.issue("chris@house");
    const signature = prove(privateKey, { address: "chris@house", nonce, ...record });
    expect(theirs.verify("chris@house", record, nonce, signature)).toEqual({
      ok: false,
      reason: "bad_nonce",
    });
  });
});
