/**
 * The house's keys — SPEC §15, the cryptographic horizon.
 *
 * Every address holds TWO keypairs:
 *   * an age keypair (X25519 + ChaCha20-Poly1305) — for sealing letters
 *   * an ed25519 keypair (RFC 8032) — for signing letters
 *
 * The house holds exactly one keypair — its own, a participant key, never
 * a master key. It opens what it is party to, and nothing else.
 *
 * Public keys are public: registered on the address record, readable by
 * anyone (verification needs them; they are not secrets). Private keys are
 * client-held — the house never holds a resident's private key, consistent
 * with "the house never holds a password."
 *
 * ── The dependency, pinned ────────────────────────────────────────────────
 * age runs through the pure-JS port (`age-encryption`), not the age CLI —
 * no extra binary in the container, no exec surface, auditable. ed25519 is
 * Node's built-in crypto — a library call, never a subprocess.
 *
 * `age-encryption` is pinned EXACTLY — 0.3.1, pinned 2026-11-08, in both
 * server/package.json and client/package.json — because this one library
 * produces every ciphertext the house stores. A caret range would let a minor
 * bump change header or stanza behaviour, and the failure would not be a loud
 * error at write time: it would be letters that no longer open. Upgrading is
 * therefore a deliberate act — bump the pin, then run the interop fixture
 * (test/unit/age-interop.test.ts) against the new build before committing.
 *
 * ── The format, not just the library ─────────────────────────────────────
 * The port implements C2SP `age` v1 — the wire format the Go reference
 * implementation (filippo.io/age) and every other age tool speak. Its two
 * marks in a sealed file: the header's first line is `age-encryption.org/v1`,
 * and the recipient stanza is labelled `age-encryption.org/v1/X25519`. So
 * "compatible" means v1, not "whatever the port's current 0.x happened to be".
 * The library is FiloSottile/typage; the spec is C2SP/C2SP `age.md`.
 *
 * Interop is asserted, not assumed: test/fixtures/age/ holds a ciphertext
 * sealed by filippo.io/age v1.3.2, which this port must open, and one sealed
 * by this port that the reference decrypted. A port bug that both writes and
 * reads a malformed header stays invisible to a same-library round-trip; this
 * fixture is the test that sees it.
 *
 * ── Armouring: where the boundary sits ───────────────────────────────────
 * The age API is byte-oriented: `Encrypter.encrypt` returns raw bytes,
 * `Decrypter.decrypt` takes raw bytes. Armour (`-----BEGIN AGE ENCRYPTED
 * FILE-----`, base64 inside a PEM-shaped envelope) is a text encoding of the
 * same bytes, about a third larger. The house armours exactly where ciphertext
 * lands in a text column, and nowhere else:
 *
 *   * `letters.body` — ARMOURED. A sealed letter's body content is armoured age
 *     text, sealed client-side (client/src/utils/crypto.ts) and, for the house's
 *     own words, by `sealToRecipients` below. It is stored as TEXT inside the
 *     letter's JSON body, so it has to survive JSON, SQL and the canonical id
 *     derivation as text. `unsealWithIdentity` armour-decodes before decrypting.
 *   * payloads (object store) — RAW BYTES, never armoured. An enclosure is
 *     stored as bytes with its content type; armour would cost a third of the
 *     file for no gain. A sealed enclosure, when it lands, is raw age bytes
 *     tagged `application/octet-stream` — it does not cross the armour boundary
 *     at all.
 *
 * The rule: armour at the text boundary; never inside a byte column or an object
 * store, and never re-armour bytes that are already ciphertext.
 */
import { createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
import {
  Decrypter,
  Encrypter,
  armor,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";

/** An address's key record — the public half, registered on the address. */
export interface AddressKeys {
  /** The address this key record belongs to. */
  address: string;
  /** The age recipient (X25519 public key) — for sealing to this address. */
  ageRecipient: string;
  /** The ed25519 public key (base64url) — for verifying this address's letters. */
  ed25519Public: string;
  /** A recovery age recipient — a second keypair held off-box. Optional. */
  recoveryAgeRecipient: string | null;
}

/** The private half — client-held, never stored by the house. */
export interface ResidentKeypair {
  /** The age identity (X25519 private key string) — for unsealing. */
  ageIdentity: string;
  /** The ed25519 private key (base64url) — for signing. */
  ed25519Private: string;
  /** The public half, for registration. */
  public: AddressKeys;
}

/** The house's own keypair — a participant key, never a master key. */
export interface HouseKeypair {
  ageIdentity: string;
  ed25519Private: string;
  ageRecipient: string;
  ed25519Public: string;
}

/** Generate a fresh ed25519 keypair. Returns base64url-encoded keys. */
export function generateEd25519Keypair(): { publicKey: string; privateKey: string } {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    publicKey: publicKey.export({ type: "spki", format: "der" }).toString("base64url"),
    privateKey: privateKey.export({ type: "pkcs8", format: "der" }).toString("base64url"),
  };
}

/**
 * Derive the ed25519 public key from its private half — spki, base64url, the
 * same encoding `generateEd25519Keypair` produces.
 *
 * This is how a house checks that the secret in its environment belongs to the
 * public halves in its database: the two are a pair or they are from different
 * houses, and there is no third state. Throws on a malformed private key.
 */
export function ed25519PublicOf(ed25519Private: string): string {
  const privateKey = createPrivateKey({
    key: Buffer.from(ed25519Private, "base64url"),
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(privateKey)
    .export({ type: "spki", format: "der" })
    .toString("base64url");
}

/** Generate a fresh age identity (X25519). Async — the library is async. */
export async function generateAgeIdentity(): Promise<string> {
  return generateX25519Identity();
}

/** The age recipient string for an identity — what you seal to. Async. */
export async function ageRecipientOf(identity: string): Promise<string> {
  return identityToRecipient(identity);
}

/** Generate a resident's full keypair (age + ed25519). Async. */
export async function generateResidentKeypair(address: string): Promise<ResidentKeypair> {
  const ageIdentity = await generateAgeIdentity();
  const ed = generateEd25519Keypair();
  return {
    ageIdentity,
    ed25519Private: ed.privateKey,
    public: {
      address,
      ageRecipient: await ageRecipientOf(ageIdentity),
      ed25519Public: ed.publicKey,
      recoveryAgeRecipient: null,
    },
  };
}

/** Generate the house's own keypair. Async. */
export async function generateHouseKeypair(): Promise<HouseKeypair> {
  const ageIdentity = await generateAgeIdentity();
  const ed = generateEd25519Keypair();
  return {
    ageIdentity,
    ed25519Private: ed.privateKey,
    ageRecipient: await ageRecipientOf(ageIdentity),
    ed25519Public: ed.publicKey,
  };
}

/** Sign a letter id with an ed25519 private key. base64url. */
export function signLetterId(letterId: string, ed25519Private: string): string {
  const key = Buffer.from(ed25519Private, "base64url");
  const privateKey = { key, type: "pkcs8", format: "der" } as const;
  return sign(null, Buffer.from(letterId, "utf8"), privateKey).toString("base64url");
}

/** Verify a letter id signature against an ed25519 public key. */
export function verifyLetterId(
  letterId: string,
  signature: string,
  ed25519Public: string,
): boolean {
  try {
    const key = Buffer.from(ed25519Public, "base64url");
    const publicKey = { key, type: "spki", format: "der" } as const;
    return verify(
      null,
      Buffer.from(letterId, "utf8"),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/** Seal a plaintext body to a set of age recipients. Returns armored ciphertext. Async. */
export async function sealToRecipients(plaintext: string, recipients: string[]): Promise<string> {
  const encrypter = new Encrypter();
  for (const recipient of recipients) {
    encrypter.addRecipient(recipient);
  }
  const raw = await encrypter.encrypt(plaintext);
  return armor.encode(raw);
}

/** Unseal armored ciphertext with an age identity. Returns plaintext, or null on failure. Async. */
export async function unsealWithIdentity(
  ciphertext: string,
  identity: string,
): Promise<string | null> {
  try {
    const decrypter = new Decrypter();
    decrypter.addIdentity(identity);
    const raw = armor.decode(ciphertext);
    return await decrypter.decrypt(raw, "text");
  } catch {
    return null;
  }
}
