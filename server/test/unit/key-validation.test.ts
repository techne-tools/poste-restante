/**
 * Key registration validation — SPEC §15.
 *
 * The leak this suite closes: `RegisterKeysSchema` accepted any non-empty
 * string as an age recipient and as an ed25519 public key. A malformed
 * recipient was discovered only when a letter failed to seal (weeks later,
 * by a different person); a malformed ed25519 key silently became the
 * address's identity, and every letter id resolved through it was wrong.
 *
 * The negatives matter more than the happy path here: each test below is a
 * string that used to be accepted and must now be refused at the door.
 */
import { describe, it, expect } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import {
  generateAgeIdentity,
  generateEd25519Keypair,
  isEd25519PublicKey,
  isSealableRecipient,
} from "../../src/crypto/keys.js";
import { RegisterKeysSchema } from "../../src/schemas.js";

/** A real recipient, from the library that will do the sealing. */
async function realRecipient(): Promise<string> {
  const { identityToRecipient } = await import("age-encryption");
  return identityToRecipient(await generateAgeIdentity());
}

const realEd25519 = () => generateEd25519Keypair().publicKey;

/** The proof half of a registration. Shape only here — the signature is
 *  verified by KeyProofService, and this suite is about the halves. */
const PROOF = { nonce: "1700000000.abc", signature: "c2lnbmF0dXJl" };

describe("the age recipient — refused unless the house can seal to it", () => {
  it("accepts a recipient the library itself produced", async () => {
    expect(isSealableRecipient(await realRecipient())).toBe(true);
  });

  it("refuses any non-empty string that is not an age recipient", () => {
    // The old rule: `z.string().min(1)`. Every one of these passed it.
    for (const bad of [
      "not-a-key",
      "age1",
      "age1" + "q".repeat(58),
      "AGE1QQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQQ",
      " age1qqqq",
      "age2qqqq",
    ]) {
      expect(isSealableRecipient(bad), bad).toBe(false);
    }
  });

  it("refuses a recipient whose checksum no longer verifies", async () => {
    const good = await realRecipient();
    // Flip one data character — the bech32 checksum is what catches this,
    // and it is the typo class that reaches production.
    const at = good.length - 10;
    const replacement = good[at] === "q" ? "p" : "q";
    const corrupt = good.slice(0, at) + replacement + good.slice(at + 1);
    expect(corrupt).not.toBe(good);
    expect(isSealableRecipient(corrupt)).toBe(false);
  });

  it("refuses a truncated recipient", async () => {
    const good = await realRecipient();
    expect(isSealableRecipient(good.slice(0, good.length - 1))).toBe(false);
    expect(isSealableRecipient(good.slice(0, 20))).toBe(false);
  });

  it("refuses an age IDENTITY pasted where a recipient belongs", async () => {
    // The private half must never travel to the house. It has the same
    // bech32 shape but a different prefix, so the encrypter refuses it.
    const identity = await generateAgeIdentity();
    expect(isSealableRecipient(identity)).toBe(false);
  });

  it("refuses an empty recipient and a non-string", () => {
    expect(isSealableRecipient("")).toBe(false);
    expect(isSealableRecipient(undefined as unknown as string)).toBe(false);
  });
});

describe("the ed25519 public key — refused unless it is the house's encoding", () => {
  it("accepts the SPKI encoding the house and the client both mint", () => {
    expect(isEd25519PublicKey(realEd25519())).toBe(true);
  });

  it("refuses a raw 32-byte key with no DER header", () => {
    // 32 zero bytes, base64url — a plausible thing for a client to send
    // and not what the id resolver can use.
    const raw = Buffer.alloc(32).toString("base64url");
    expect(isEd25519PublicKey(raw)).toBe(false);
  });

  it("refuses a truncated SPKI key", () => {
    const der = Buffer.from(realEd25519(), "base64url");
    const short = der.subarray(0, der.length - 4).toString("base64url");
    expect(isEd25519PublicKey(short)).toBe(false);
  });

  it("refuses a SPKI key for a different algorithm", () => {
    // A real, well-formed SPKI — for the wrong curve. Length and header
    // differ, so it must be refused before any signature check.
    const { publicKey } = generateKeyPairSync("x25519");
    const spki = publicKey.export({ type: "spki", format: "der" }).toString("base64url");
    expect(isEd25519PublicKey(spki)).toBe(false);
  });

  it("refuses a key that has trailing bytes after the SPKI structure", () => {
    const der = Buffer.from(realEd25519(), "base64url");
    const padded = Buffer.concat([der, Buffer.from([0, 0])]).toString("base64url");
    expect(isEd25519PublicKey(padded)).toBe(false);
  });

  it("refuses standard base64 (padded or with + or /)", () => {
    const spki = Buffer.from(realEd25519(), "base64url");
    const standard = spki.toString("base64");
    expect(isEd25519PublicKey(standard)).toBe(false);
    expect(isEd25519PublicKey(spki.toString("base64url") + "==")).toBe(false);
  });

  it("refuses empty and non-alphabet strings", () => {
    expect(isEd25519PublicKey("")).toBe(false);
    expect(isEd25519PublicKey("!!!")).toBe(false);
    expect(isEd25519PublicKey("not a key")).toBe(false);
  });
});

describe("the registration schema — the door the route actually uses", () => {
  it("accepts a complete, well-formed record with no recovery recipient", async () => {
    const parsed = RegisterKeysSchema.safeParse({
      ageRecipient: await realRecipient(),
      ed25519Public: realEd25519(),
      ...PROOF,
    });
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;
    expect(parsed.data.recoveryAgeRecipient).toBeNull();
  });

  it("accepts a well-formed recovery recipient when one is offered", async () => {
    const parsed = RegisterKeysSchema.safeParse({
      ageRecipient: await realRecipient(),
      ed25519Public: realEd25519(),
      recoveryAgeRecipient: await realRecipient(),
      ...PROOF,
    });
    expect(parsed.success).toBe(true);
  });

  it("refuses a malformed age recipient", async () => {
    const parsed = RegisterKeysSchema.safeParse({
      ageRecipient: "age1not-really-a-key",
      ed25519Public: realEd25519(),
      ...PROOF,
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a malformed ed25519 public key", async () => {
    const parsed = RegisterKeysSchema.safeParse({
      ageRecipient: await realRecipient(),
      ed25519Public: "aGVsbG8",
      ...PROOF,
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a malformed recovery recipient — it is sealed to, so it is validated too", async () => {
    const parsed = RegisterKeysSchema.safeParse({
      ageRecipient: await realRecipient(),
      ed25519Public: realEd25519(),
      recoveryAgeRecipient: "age1garbage",
      ...PROOF,
    });
    expect(parsed.success).toBe(false);
  });

  it("refuses a record with no proof at all — the halves alone are not a registration", async () => {
    const halves = {
      ageRecipient: await realRecipient(),
      ed25519Public: realEd25519(),
    };
    expect(RegisterKeysSchema.safeParse(halves).success).toBe(false);
    expect(RegisterKeysSchema.safeParse({ ...halves, nonce: "n" }).success).toBe(false);
    expect(RegisterKeysSchema.safeParse({ ...halves, signature: "s" }).success).toBe(false);
  });

  it("refuses a record whose halves are missing or empty", () => {
    expect(RegisterKeysSchema.safeParse({ ed25519Public: realEd25519() }).success).toBe(false);
    expect(
      RegisterKeysSchema.safeParse({ ageRecipient: "", ed25519Public: "" }).success,
    ).toBe(false);
  });
});
