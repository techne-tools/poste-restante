/**
 * The resident's key material — SPEC §15, client side.
 *
 * The house holds exactly one keypair (its own, a participant key); the
 * resident holds theirs. This module is where the resident's private
 * halves are made and used: age (X25519) identities sealed with ChaCha20-
 * Poly1305 via the pure-ESM noble stack, and the ed25519 signing key via
 * WebCrypto. It generates material and performs seals; it never decides
 * where the material rests — that is `keystore.ts`, which holds the
 * passphrase-wrapped copy and the in-memory session.
 *
 * The split exists so custody can depend on the primitives without a
 * circular import. `crypto.ts` re-exports everything here, so call sites
 * are unchanged.
 */

import {
  Decrypter,
  Encrypter,
  armor,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";

/** The resident's full keypair, as held client-side.
 *
 *  The age identity is a STRING — the age library needs it to unseal, so
 *  it cannot be a non-extractable CryptoKey. There is no parity between
 *  the two halves of this record and the code must not imply there is:
 *
 *    age identity      — a string; passphrase-wrapping is its only protection.
 *    ed25519 private   — a WebCrypto key; the working copy is imported
 *                        non-extractable (see `signingKey.ts`), so scripts can
 *                        ask the browser to sign but cannot read the key out.
 *                        A wrapped pkcs8 copy is kept because the signing key
 *                        IS the identity (§19) and must survive the browser.
 */
export interface ResidentKeys {
  /** The age identity (X25519 private key) — for unsealing. */
  ageIdentity: string;
  /** The age recipient (X25519 public) — sealed to by correspondents. */
  ageRecipient: string;
  /** The ed25519 private key (base64url pkcs8 DER) — for signing. */
  ed25519Private: string;
  /** The ed25519 public key (base64url spki DER) — the identity. */
  ed25519Public: string;
  /** The recovery age identity (X25519 private key) — the §15 backstop.
   *  Minted once, shown once, held off-box by the resident; the house
   *  holds only the public recipient and seal to it on every sealed
   *  letter. Kept here so the same browser can recover a lost primary
   *  session without the house holding anything. Null until minted. */
  recoveryAgeIdentity: string | null;
  /** The recovery age recipient — public, registered with the house. */
  recoveryAgeRecipient: string | null;
}

/** The public halves — what the house holds, and all the client may show
 *  while the keystore is sealed. */
export type PublicHalves = Pick<
  ResidentKeys,
  "ageRecipient" | "ed25519Public" | "recoveryAgeRecipient"
>;

/** Encode bytes to base64url (browser-safe; Node's Buffer does not exist
 *  in the bundle). */
export function toBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Decode a base64url string to bytes (browser-safe). */
export function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Export a WebCrypto key to base64url DER (spki for public, pkcs8 for
 *  private) — the same byte encodings the server's node:crypto produces
 *  (crypto/keys.ts::generateEd25519Keypair), so client-minted keys
 *  verify server-side and vice versa. */
export async function exportBase64url(
  format: "spki" | "pkcs8",
  key: CryptoKey,
): Promise<string> {
  const der = await crypto.subtle.exportKey(format, key);
  return toBase64url(new Uint8Array(der));
}

/** Mint a resident's keypair (age + ed25519) entirely in the browser.
 *  The ed25519 key is generated extractable HERE and only here: the pkcs8
 *  goes straight into the wrapped keystore and the working copy is then
 *  imported non-extractable. A key generated non-extractable could never
 *  be backed up, and this key is the resident's identity (§19) — an
 *  unbackupable identity is exactly the loss this keystore exists to
 *  prevent. Nothing extractable is ever persisted outside ciphertext.
 *
 *  The recovery age identity is not minted here — it is a deliberate
 *  act (mint on demand, show once, hold off-box), so a fresh keystore
 *  starts with neither recovery identity nor recipient. */
export async function generateKeys(): Promise<ResidentKeys> {
  const ageIdentity = await generateX25519Identity();
  const ageRecipient = await identityToRecipient(ageIdentity);
  const ed = await crypto.subtle.generateKey({ name: "Ed25519" }, true, ["sign", "verify"]);
  const ed25519Private = await exportBase64url("pkcs8", ed.privateKey);
  const ed25519Public = await exportBase64url("spki", ed.publicKey);
  return {
    ageIdentity,
    ageRecipient,
    ed25519Private,
    ed25519Public,
    recoveryAgeIdentity: null,
    recoveryAgeRecipient: null,
  };
}

/** Mint a recovery age identity — the §15 backstop. The private half is
 *  shown once and held off-box by the resident; the public recipient is
 *  registered with the house and kept here so the keystore can recover a
 *  lost session. */
export async function mintRecoveryPair(): Promise<{
  identity: string;
  recipient: string;
}> {
  const identity = await generateX25519Identity();
  const recipient = await identityToRecipient(identity);
  return { identity, recipient };
}

/** Import a pkcs8 ed25519 private key NON-EXTRACTABLE — the working copy
 *  an XSS cannot read out. Both signing paths below use this. */
export async function importSigningKey(pkcs8Base64url: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "pkcs8",
    fromBase64url(pkcs8Base64url),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
}

/** Sign a letter id with a non-extractable signing key. The server
 *  verifies with the public half on the address record (public keys are
 *  public). */
export async function signLetterIdWithKey(id: string, key: CryptoKey): Promise<string> {
  const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(id));
  return toBase64url(new Uint8Array(sig));
}

/** Sign a letter id from a base64url pkcs8 key. Kept for call sites that
 *  hold the exported form; the browser path uses `signLetterIdWithKey`. */
export async function signLetterId(id: string, ed25519Private: string): Promise<string> {
  return signLetterIdWithKey(id, await importSigningKey(ed25519Private));
}

/** Seal a plaintext body to a set of age recipients. Armored, like the
 *  server's sealToRecipients — so a letter the house stores looks
 *  exactly like a letter the house would seal itself. */
export async function sealToRecipients(
  plaintext: string,
  recipients: string[],
): Promise<string> {
  const encrypter = new Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  const raw = await encrypter.encrypt(plaintext);
  return armor.encode(raw);
}

/** Seal a payload to a passphrase (age's scrypt recipient). This is the
 *  backup-file primitive: a standard age file, openable with `age -d` or
 *  any age implementation, so a resident is never locked into this client
 *  to read their own backup. */
export async function sealToPassphrase(
  plaintext: string,
  passphrase: string,
): Promise<string> {
  const encrypter = new Encrypter();
  encrypter.setPassphrase(passphrase);
  return armor.encode(await encrypter.encrypt(plaintext));
}

/** Unseal an armored ciphertext with the resident's age identity.
 *  Returns null on failure (wrong key, tamper, malformed armor). */
export async function unsealWithIdentity(
  ciphertext: string,
  ageIdentity: string,
): Promise<string | null> {
  try {
    const decrypter = new Decrypter();
    decrypter.addIdentity(ageIdentity);
    return await decrypter.decrypt(armor.decode(ciphertext), "text");
  } catch {
    return null;
  }
}

/** Unseal a passphrase-sealed age file. Returns null on failure (wrong
 *  passphrase, tamper, malformed armor). */
export async function unsealWithPassphrase(
  ciphertext: string,
  passphrase: string,
): Promise<string | null> {
  try {
    const decrypter = new Decrypter();
    decrypter.addPassphrase(passphrase);
    return await decrypter.decrypt(armor.decode(ciphertext), "text");
  } catch {
    return null;
  }
}
