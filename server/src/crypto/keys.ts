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
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, sign, verify } from "node:crypto";
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

/**
 * Can the house actually seal to this recipient string?
 *
 * The question a registration must answer before it is stored: a recipient
 * the encrypter cannot parse is a recipient a letter cannot be sealed to,
 * and today that is discovered only when a letter fails to seal — or worse,
 * when a correspondent seals to a typo and the letter is unopenable.
 *
 * Defined by the encrypter itself rather than by a hand-rolled bech32
 * check, so the test of validity is exactly the operation that will use
 * it. Accepts every recipient form age's `addRecipient` accepts (X25519
 * `age1…`, and the hybrid/tag forms), which is the honest boundary: if
 * sealing would take it, registration should.
 */
export function isSealableRecipient(recipient: string): boolean {
  if (typeof recipient !== "string" || !recipient.startsWith("age1")) return false;
  try {
    // No cryptographic work happens here — addRecipient only parses the
    // recipient (bech32 decode + length) and builds a wrapper.
    new Encrypter().addRecipient(recipient);
    return true;
  } catch {
    return false;
  }
}

/** The SPKI SubjectPublicKeyInfo header for an ed25519 key: the 12 fixed
 *  bytes every ed25519 public key in the house's encoding begins with. */
const ED25519_SPKI_HEADER = Buffer.from("302a300506032b6570032100", "hex");

/**
 * Is this the house's ed25519 public-key encoding — base64url of a DER
 * SubjectPublicKeyInfo whose one key is 32 bytes and whose algorithm is
 * ed25519?
 *
 * The encoding is the one `generateEd25519Keypair` produces and the client
 * produces (`exportBase64url("spki", …)`), so a registration carrying
 * anything else — a raw 32-byte key, a truncated DER, a different
 * algorithm, a standard-base64 string — is a key the letter-id resolver
 * cannot use, and the identity spine would be silently wrong.
 */
export function isEd25519PublicKey(publicKey: string): boolean {
  // base64url, unpadded. Node's decoder is lenient, so the alphabet is
  // checked before decoding rather than after.
  if (typeof publicKey !== "string" || !/^[A-Za-z0-9_-]+$/.test(publicKey)) return false;
  const der = Buffer.from(publicKey, "base64url");
  // 12 header bytes + the 32-byte key. Exact, so no trailing bytes.
  if (der.length !== 44) return false;
  if (!der.subarray(0, ED25519_SPKI_HEADER.length).equals(ED25519_SPKI_HEADER)) return false;
  try {
    const key = createPublicKey({ key: der, format: "der", type: "spki" });
    return key.asymmetricKeyType === "ed25519";
  } catch {
    return false;
  }
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

/** Verify an ed25519 signature over arbitrary UTF-8 text. */
export function verifySignedText(
  text: string,
  signature: string,
  ed25519Public: string,
): boolean {
  try {
    const key = Buffer.from(ed25519Public, "base64url");
    const publicKey = { key, type: "spki", format: "der" } as const;
    return verify(
      null,
      Buffer.from(text, "utf8"),
      publicKey,
      Buffer.from(signature, "base64url"),
    );
  } catch {
    return false;
  }
}

/** Verify a letter id signature against an ed25519 public key. */
export function verifyLetterId(
  letterId: string,
  signature: string,
  ed25519Public: string,
): boolean {
  return verifySignedText(letterId, signature, ed25519Public);
}

/**
 * A public key's fingerprint — sha256 of the key as registered, hex.
 *
 * Public keys are public, so this is not a secret; it is a stable, short
 * name for a key that can go in a log without the key itself (or the
 * address that holds it) travelling with it.
 */
export function keyFingerprint(ed25519Public: string): string {
  return createHash("sha256").update(ed25519Public).digest("hex");
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

/**
 * What an unseal attempt can say.
 *
 * The old signature returned `null` for three different facts — "not a
 * recipient", "tampered", "malformed armour" — so a caller could only
 * report "no", and a reader was told a tampered letter was not theirs.
 *
 * age itself draws exactly one of those lines, and we keep exactly that
 * one: when NO stanza unwraps with the identity, the ciphertext is not
 * addressed to it (`not_recipient`). Everything else — armour that will
 * not decode, a header MAC that does not hold, a payload stream that fails
 * its tag — collapses to `failed`, which is the honest word: age cannot
 * say *why*, and pretending to would be a claim the cipher does not make.
 *
 * A malformed IDENTITY is not an outcome of the ciphertext at all: it is a
 * caller bug or a broken configuration, and it throws rather than being
 * reported as a fact about the letter.
 */
export type UnsealOutcome =
  | { ok: true; plaintext: string }
  | { ok: false; reason: "not_recipient" | "failed" };

/** age's own answer when no stanza unwraps: "no identity matched any of
 *  the file's recipients". The library exposes no distinct error type, so
 *  the message is the only signal the wire gives us. The test suite locks
 *  it with a real wrong-identity ciphertext, so a library upgrade that
 *  reworded it would fail a test rather than silently reclassify a
 *  tampered letter as "not yours". */
const AGE_NO_RECIPIENT = /no identity matched/i;

/** Unseal armored ciphertext with an age identity. Async. */
export async function unsealWithIdentity(
  ciphertext: string,
  identity: string,
): Promise<UnsealOutcome> {
  let raw: Uint8Array;
  try {
    raw = armor.decode(ciphertext);
  } catch {
    // Not age armour at all. There is nothing here to be a recipient of.
    return { ok: false, reason: "failed" };
  }
  // Outside the try: an identity that will not parse is the caller's
  // problem, not a verdict on the letter.
  const decrypter = new Decrypter();
  decrypter.addIdentity(identity);
  try {
    return { ok: true, plaintext: await decrypter.decrypt(raw, "text") };
  } catch (err) {
    return {
      ok: false,
      reason: AGE_NO_RECIPIENT.test(err instanceof Error ? err.message : "") ? "not_recipient" : "failed",
    };
  }
}
