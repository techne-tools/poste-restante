/**
 * The house's keys — SPEC §15, hermetic unit tests.
 *
 * These prove the cryptographic primitives without any infra: age
 * seal/unseal round-trips, ed25519 sign/verify, tamper detection, and
 * the keypair generation shapes.
 */
import { describe, it, expect } from "vitest";
import {
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
    const pt = await unsealWithIdentity(ct, you.ageIdentity);
    expect(pt).toBe("the storm is coming");
  });

  it("cannot unseal with the wrong identity", async () => {
    const you = await generateResidentKeypair("you@house");
    const ben = await generateResidentKeypair("ben@house");
    const ct = await sealToRecipients("for your eyes only", [you.public.ageRecipient]);
    const pt = await unsealWithIdentity(ct, ben.ageIdentity);
    expect(pt).toBeNull();
  });

  it("seals to multiple recipients — any one can unseal", async () => {
    const you = await generateResidentKeypair("you@house");
    const house = await generateHouseKeypair();
    const ct = await sealToRecipients("collaborative", [
      you.public.ageRecipient,
      house.ageRecipient,
    ]);
    expect(await unsealWithIdentity(ct, you.ageIdentity)).toBe("collaborative");
    expect(await unsealWithIdentity(ct, house.ageIdentity)).toBe("collaborative");
  });

  it("returns null for garbage ciphertext", async () => {
    const you = await generateResidentKeypair("you@house");
    expect(await unsealWithIdentity("not age ciphertext", you.ageIdentity)).toBeNull();
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
});
