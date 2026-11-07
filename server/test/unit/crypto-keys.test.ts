/**
 * The house's keys — SPEC §15, hermetic unit tests.
 *
 * These prove the cryptographic primitives without any infra: age
 * seal/unseal round-trips, ed25519 sign/verify, tamper detection, and
 * the keypair generation shapes.
 */
import { describe, it, expect } from "vitest";
import { armor } from "age-encryption";
import {
  ed25519PublicOf,
  generateEd25519Keypair,
  generateHouseKeypair,
  generateResidentKeypair,
  sealToRecipients,
  signLetterId,
  unsealWithIdentity,
  verifyLetterId,
} from "../../src/crypto/keys.js";

describe("ed25519 signing", () => {
  it("signs and verifies a letter id", () => {
    const ed = generateEd25519Keypair();
    const id = "abc123def456";
    const sig = signLetterId(id, ed.privateKey);
    expect(sig.length).toBeGreaterThan(40);
    expect(verifyLetterId(id, sig, ed.publicKey)).toBe(true);
  });

  it("rejects a tampered letter id", () => {
    const ed = generateEd25519Keypair();
    const sig = signLetterId("abc123", ed.privateKey);
    expect(verifyLetterId("abc124", sig, ed.publicKey)).toBe(false);
  });

  it("rejects a signature from a different key", () => {
    const a = generateEd25519Keypair();
    const b = generateEd25519Keypair();
    const sig = signLetterId("abc123", a.privateKey);
    expect(verifyLetterId("abc123", sig, b.publicKey)).toBe(false);
  });

  it("rejects a malformed public key", () => {
    expect(verifyLetterId("abc123", "not-a-signature", "not-a-key")).toBe(false);
  });
});

describe("age sealing", () => {
  it("seals to a recipient and unseals with the identity", async () => {
    const you = await generateResidentKeypair("you@house");
    const ct = await sealToRecipients("the storm is coming", [you.public.ageRecipient]);
    expect(ct.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")).toBe(true);
    expect(await unsealWithIdentity(ct, you.ageIdentity)).toEqual({
      ok: true,
      plaintext: "the storm is coming",
    });
  });

  it("says 'not_recipient' with the wrong identity — a fact about addressing", async () => {
    const you = await generateResidentKeypair("you@house");
    const ben = await generateResidentKeypair("ben@house");
    const ct = await sealToRecipients("for your eyes only", [you.public.ageRecipient]);
    // The one distinction age itself draws: no stanza unwraps. It is not a
    // verdict on the letter's integrity, and the reader is told so.
    expect(await unsealWithIdentity(ct, ben.ageIdentity)).toEqual({
      ok: false,
      reason: "not_recipient",
    });
  });

  it("seals to multiple recipients — any one can unseal", async () => {
    const you = await generateResidentKeypair("you@house");
    const house = await generateHouseKeypair();
    const ct = await sealToRecipients("collaborative", [
      you.public.ageRecipient,
      house.ageRecipient,
    ]);
    expect(await unsealWithIdentity(ct, you.ageIdentity)).toEqual({
      ok: true,
      plaintext: "collaborative",
    });
    expect(await unsealWithIdentity(ct, house.ageIdentity)).toEqual({
      ok: true,
      plaintext: "collaborative",
    });
  });

  it("says 'failed' for garbage — malformed armour is not a verdict on addressing", async () => {
    const you = await generateResidentKeypair("you@house");
    expect(await unsealWithIdentity("not age ciphertext", you.ageIdentity)).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("says 'failed', not 'not_recipient', when a letter addressed to you has been tampered with", async () => {
    const you = await generateResidentKeypair("you@house");
    const plaintext = "the storm is coming, read at the tech";
    // Long enough that the last byte is payload, not header.
    const ct = await sealToRecipients(plaintext, [you.public.ageRecipient]);
    const raw = new Uint8Array(armor.decode(ct));
    raw[raw.length - 1] ^= 0xff;
    const tampered = armor.encode(raw);

    // This is the whole point of the item: a recipient told "not yours" about
    // their own letter goes looking for the wrong problem.
    expect(await unsealWithIdentity(tampered, you.ageIdentity)).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("says 'failed' when the header itself was altered", async () => {
    const you = await generateResidentKeypair("you@house");
    const ct = await sealToRecipients("header integrity", [you.public.ageRecipient]);
    // The header is the first line of age's binary form; the MAC covers it.
    const raw = new Uint8Array(armor.decode(ct));
    const at = raw.indexOf(0x2d /* '-' */) + 4;
    raw[at] ^= 0x01;
    expect(await unsealWithIdentity(armor.encode(raw), you.ageIdentity)).toEqual({
      ok: false,
      reason: "failed",
    });
  });

  it("throws on a malformed identity rather than blaming the letter", async () => {
    const you = await generateResidentKeypair("you@house");
    const ct = await sealToRecipients("the storm is coming", [you.public.ageRecipient]);
    // A broken KEY is the caller's problem (a misconfiguration), not an
    // outcome of the ciphertext. Saying 'failed' would hide a bad secret
    // behind a verdict about the letter.
    await expect(unsealWithIdentity(ct, "not-an-age-identity")).rejects.toThrow();
  });
});

describe("keypair generation", () => {
  it("generates a resident keypair with the public half registered", async () => {
    const you = await generateResidentKeypair("you@house");
    expect(you.public.address).toBe("you@house");
    expect(you.public.ageRecipient.startsWith("age1")).toBe(true);
    expect(you.public.ed25519Public.length).toBeGreaterThan(40);
    expect(you.public.recoveryAgeRecipient).toBeNull();
    expect(you.ageIdentity.startsWith("AGE-SECRET-KEY-1")).toBe(true);
  });

  it("generates the house keypair — a participant key, never a master key", async () => {
    const house = await generateHouseKeypair();
    expect(house.ageRecipient.startsWith("age1")).toBe(true);
    expect(house.ed25519Public.length).toBeGreaterThan(40);
    expect(house.ageIdentity.startsWith("AGE-SECRET-KEY-1")).toBe(true);
  });

  it("derives the ed25519 public half from its private half — the custody check", () => {
    // The house proves a secret belongs to a stored public half by deriving
    // one from the other. A different private key must derive something else,
    // or "the secret matches the database" would mean nothing.
    const ed = generateEd25519Keypair();
    expect(ed25519PublicOf(ed.privateKey)).toBe(ed.publicKey);
    expect(ed25519PublicOf(generateEd25519Keypair().privateKey)).not.toBe(ed.publicKey);
    // Malformed input throws rather than returning something plausible.
    expect(() => ed25519PublicOf("not-a-key")).toThrow();
  });
});
