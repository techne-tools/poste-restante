/**
 * The resident's cryptography — SPEC §15, client side.
 *
 * The house holds exactly one keypair (its own, a participant key); the
 * resident holds theirs. This module is where the resident's private
 * halves live: generated in the browser, sealed with age
 * (ChaCha20-Poly1305 via the pure-ESM noble stack), signed with ed25519
 * via WebCrypto (no extra dependency). The house stores only the public
 * halves and never sees the secrets.
 *
 * The letter id is derived EXACTLY as the server derives it
 * (id.ts::canonicaliseWith + letterIdFromCanonical): sha256 of a
 * canonical JSON serialisation of the zod-parsed letter, with each
 * handle resolved to its identity (the ed25519 public fingerprint, §19;
 * legacy addresses without keys resolve to the handle itself). The
 * client must reproduce that derivation byte-for-byte — a drifted
 * canonical form would make the id never match on the server side and
 * every sealed letter would be rejected at the signature gate.
 *
 * Key custody: the private halves live in localStorage alongside the
 * auth header (the same trust domain — a bearer credential the house
 * never sees either). The house never holds them; this file never
 * sends them.
 *
 * This is the in-common that is nothing-in-common, made cryptographic
 * (Nancy): the house shares the with — the letters circulate through it —
 * but the sealed body's substance never passes to the house. Sharing is
 * the circulation, not the pooled content.
 */

import {
  Decrypter,
  Encrypter,
  armor,
  generateX25519Identity,
  identityToRecipient,
} from "age-encryption";

/** The resident's full keypair, as held client-side. */
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

const KEYS_KEY = "poste-restante.keys";

/** The client-held keystore — one keypair per address. */
export function loadKeys(address: string): ResidentKeys | null {
  try {
    const raw = localStorage.getItem(KEYS_KEY);
    if (!raw) return null;
    const all = JSON.parse(raw) as Record<string, ResidentKeys>;
    return all[address] ?? null;
  } catch {
    return null;
  }
}

function storeKeys(address: string, keys: ResidentKeys): void {
  const all = JSON.parse(localStorage.getItem(KEYS_KEY) ?? "{}") as Record<string, ResidentKeys>;
  all[address] = keys;
  localStorage.setItem(KEYS_KEY, JSON.stringify(all));
}

/** Export a WebCrypto key to base64url DER (spki for public, pkcs8 for
 *  private) — the same byte encodings the server's node:crypto produces
 *  (crypto/keys.ts::generateEd25519Keypair), so client-minted keys
 *  verify server-side and vice versa. */
async function exportBase64url(format: "spki" | "pkcs8", key: CryptoKey): Promise<string> {
  const der = await crypto.subtle.exportKey(format, key);
  return btoa(String.fromCharCode(...new Uint8Array(der))).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Decode a base64url string to bytes (browser-safe; Node's Buffer does
 *  not exist in the bundle). */
function fromBase64url(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Encode bytes to base64url (browser-safe). */
function toBase64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/=+$/, "").replace(/\+/g, "-").replace(/\//g, "_");
}

/** Mint a resident's keypair (age + ed25519) entirely in the browser.
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

/** Mint the recovery age identity — the §15 backstop. The private
 *  half is shown once and held off-box by the resident; the public
 *  recipient is registered with the house and returns here so the
 *  keystore can recover a lost session. Returns the updated keystore
 *  and the plain private identity, for the one-time reveal. */
export async function mintRecoveryIdentity(address: string): Promise<{
  keys: ResidentKeys;
  recoveryIdentity: string;
}> {
  const existing = loadKeys(address);
  const base = existing ?? (await generateKeys());
  if (base.recoveryAgeIdentity) {
    // Idempotent — a recovery identity already exists; re-show it.
    return { keys: base, recoveryIdentity: base.recoveryAgeIdentity };
  }
  const recoveryAgeIdentity = await generateX25519Identity();
  const recoveryAgeRecipient = await identityToRecipient(recoveryAgeIdentity);
  const next: ResidentKeys = {
    ...base,
    recoveryAgeIdentity,
    recoveryAgeRecipient,
  };
  storeKeys(address, next);
  return { keys: next, recoveryIdentity: recoveryAgeIdentity };
}

/** The recovery recipient for an address's key record — used when
 *  registering keys, so the house can serve it to correspondents. */
export function recoveryRecipientOf(keys: ResidentKeys): string | null {
  return keys.recoveryAgeRecipient;
}

/** Ensure the resident has keys — auto-minting on first use. The house
 *  stores only the public halves (registered through the API); the
 *  private halves never leave the browser. */
export async function ensureKeys(address: string): Promise<ResidentKeys> {
  const existing = loadKeys(address);
  if (existing) return existing;
  const fresh = await generateKeys();
  storeKeys(address, fresh);
  return fresh;
}

/** Sign a letter id with the resident's ed25519 private key. The server
 *  verifies with the public half on the address record (public keys are
 *  public). */
export async function signLetterId(id: string, ed25519Private: string): Promise<string> {
  const raw = await crypto.subtle.importKey(
    "pkcs8",
    fromBase64url(ed25519Private),
    { name: "Ed25519" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign(
    "Ed25519",
    raw,
    new TextEncoder().encode(id),
  );
  return toBase64url(new Uint8Array(sig));
}

/** Seal a plaintext body to a set of age recipients. Armored, like the
 *  server's sealToRecipients — so a letter the house stores looks
 *  exactly like a letter the house would seal itself. */
export async function sealToRecipients(plaintext: string, recipients: string[]): Promise<string> {
  const encrypter = new Encrypter();
  for (const recipient of recipients) encrypter.addRecipient(recipient);
  const raw = await encrypter.encrypt(plaintext);
  return armor.encode(raw);
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
    const raw = armor.decode(ciphertext);
    return await decrypter.decrypt(raw, "text");
  } catch {
    return null;
  }
}

/* ── The letter id — the exact mirror of server id.ts ───────────────────── */

export interface LetterForCanonical {
  envelope: {
    from: string;
    to: string[];
    cc: string[];
    thread: string;
    kind: string;
    lang: string;
    subject: string;
  };
  time: {
    gregorian: string;
    frames: { frame: string; value: string }[];
  };
  body: {
    format: string;
    content: string;
  };
}

/** Resolve a set of handles to their identity ids. The map is
 *  handle → identity id; absent addresses resolve to themselves (legacy —
 *  the identity IS the handle until a key exists). The client reads the
 *  address book's public key records — the same source the server's
 *  resolver reads (address_keys). */
export type IdentityMap = Map<string, string>;

export function canonicalise(
  letter: LetterForCanonical,
  identities: IdentityMap,
): string {
  const frames = [...letter.time.frames]
    .sort((a, b) =>
      a.frame === b.frame ? a.value.localeCompare(b.value) : a.frame.localeCompare(b.frame),
    )
    .map((f) => `${f.frame}=${f.value}`)
    .join(",");

  const resolve = (handle: string) => identities.get(handle) ?? handle;

  return JSON.stringify({
    envelope: {
      from: resolve(letter.envelope.from),
      to: letter.envelope.to.map(resolve),
      cc: letter.envelope.cc.map(resolve),
      thread: letter.envelope.thread,
      kind: letter.envelope.kind,
      lang: letter.envelope.lang,
      subject: letter.envelope.subject,
    },
    time: {
      gregorian: letter.time.gregorian,
      frames,
    },
    body: {
      format: letter.body.format,
      content: letter.body.content,
    },
  });
}

/** sha256 hex of the canonical serialisation — the letter id. */
export async function letterIdFromCanonical(canonical: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonical));
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/* ── The seal — turning a draft into a delivered sealed letter ──────────── */

/** A participant's public halves, from the address book. */ 
export interface ParticipantKeys {
  id: string;
  ageRecipient: string | null;
  ed25519Public: string | null;
  /** The recovery age recipient — the §15 backstop. Sealed to whenever
   *  present, so a correspondent whose primary key is lost can still
   *  open with the off-box recovery key. */
  recoveryAgeRecipient: string | null;
}

/**
 * Seal a drafted letter (SPEC §15, movement one: the resident half).
 *
 * The flow:
 *   1. Ensure the resident's keypair — minted in the browser on first
 *      use, held only client-side. The house never sees the private
 *      halves.
 *   2. Register the public halves with the house (self-only, idempotent
 *      upsert; skipped when the address record already carries ours).
 *   3. Resolve every participant (from/to/cc, plus the writer) through
 *      the address book: an address with keys resolves to its ed25519
 *      fingerprint — the identity IS the key (§19). An address without
 *      keys resolves to its handle (the legacy identity). This must be
 *      EXACTLY the map the server's pipeline builds at ingest, or the
 *      id will not match and the signature gate will reject the letter.
 *   4. Derive the letter id from the canonical form with that map —
 *      the same sha256 the server derives.
 *   5. Sign the id with the writer's ed25519 private key.
 *   6. Seal the plaintext body to every participant's age recipient.
 *
 * v1 refuses to seal to participants without keys: a letter sealed to
 * fewer than its addresses would silently exclude someone it is
 * addressed to — the house does not decide who can read a letter; its
 * writer does. (Collaborative sealing to house@house — where the house
 * holds a participant key — is the recorded follow-on, SPEC §15.)
 */
export interface SealResult {
  letter: {
    envelope: LetterForCanonical["envelope"];
    time: LetterForCanonical["time"];
    body: { format: "sealed"; content: string; recipients: string[]; signature: string };
  };
  id: string;
  /** True when this call minted and registered a fresh keypair. */
  minted: boolean;
}

export async function sealDraft(
  draft: LetterForCanonical,
  addressBook: ParticipantKeys[],
  opts: {
    /** Register the public halves with the house (self-only, idempotent
     *  upsert). The callback is injected so this module stays a leaf —
     *  no dependence on the fetch client; the caller supplies it. */
    registerKeys: (
      id: string,
      keys: { ageRecipient: string; ed25519Public: string; recoveryAgeRecipient?: string | null },
    ) => Promise<unknown>;
  },
): Promise<SealResult> {
  const keys = await ensureKeys(draft.envelope.from);
  const own = addressBook.find((a) => a.id === draft.envelope.from);
  const minted = !own || own.ed25519Public !== keys.ed25519Public;

  if (minted) {
    await opts.registerKeys(draft.envelope.from, {
      ageRecipient: keys.ageRecipient,
      ed25519Public: keys.ed25519Public,
      recoveryAgeRecipient: keys.recoveryAgeRecipient,
    });
  }

  // Every participant must be resolvable to a recipient. The writer is
  // always a participant (their own key exists by construction). Each
  // participant's recovery recipient is sealed to as well, when present
  // — the §15 backstop: a correspondent whose primary key is lost can
  // still open the letter with the off-box recovery key.
  const participants = new Set([
    draft.envelope.from,
    ...draft.envelope.to,
    ...draft.envelope.cc,
  ]);
  const byAddress = new Map(addressBook.map((a) => [a.id, a]));
  const recipients: string[] = [];
  const identities = new Map<string, string>();

  for (const handle of participants) {
    const rec = byAddress.get(handle);
    if (handle === draft.envelope.from) {
      identities.set(handle, keys.ed25519Public);
      recipients.push(keys.ageRecipient);
      if (keys.recoveryAgeRecipient) recipients.push(keys.recoveryAgeRecipient);
      continue;
    }
    if (!rec || !rec.ed25519Public || !rec.ageRecipient) {
      throw new Error(
        `${handle} has no keys registered — seal to ${handle} once they register theirs`,
      );
    }
    identities.set(handle, rec.ed25519Public);
    recipients.push(rec.ageRecipient);
    if (rec.recoveryAgeRecipient) recipients.push(rec.recoveryAgeRecipient);
  }

  // The subject moves into the body for sealed letters (SPEC §15: the
  // subject is the one envelope field that is pure content). The first
  // line of the sealed plaintext is the title; the reader renders it as
  // the subject. The envelope's subject is sent empty — the house
  // shows "sealed letter" — and both sides hash the same stored form.
  const title = draft.envelope.subject.trim();
  const plaintext = title ? `${title}\n\n${draft.body.content}` : draft.body.content;
  const content = await sealToRecipients(plaintext, recipients);

  // The id hashes the STORED form — envelope, time, and the
  // ciphertext body (canonicalise only uses format + content; the
  // signature and recipients are carried but never hashed). Seal
  // FIRST, then derive — the server re-derives from the letter it
  // receives, which is exactly this one.
  const sealedDraft: LetterForCanonical = {
    ...draft,
    envelope: { ...draft.envelope, subject: "" },
    body: { format: "sealed", content },
  };
  const canonical = canonicalise(sealedDraft, identities);
  const id = await letterIdFromCanonical(canonical);
  const signature = await signLetterId(id, keys.ed25519Private);

  return {
    letter: {
      envelope: sealedDraft.envelope,
      time: sealedDraft.time,
      body: { format: "sealed", content, recipients, signature },
    },
    id,
    minted,
  };
}

/**
 * Decrypt a sealed letter's body with the resident's own keys. Returns
 * null when the resident is not a recipient (wrong key) or the armor is
 * malformed. The envelope is always visible; the body waits.
 *
 * Fallback: when the primary age identity fails (lost — the §15 case),
 * the resident's recovery identity is tried. The house never holds the
 * recovery private half; it lives with the resident, off-box, and in
 * this keystore so a lost session can be recovered.
 */
export async function unsealLetterBody(
  address: string,
  ciphertext: string,
): Promise<string | null> {
  const keys = loadKeys(address);
  if (!keys) return null;
  const primary = await unsealWithIdentity(ciphertext, keys.ageIdentity);
  if (primary !== null) return primary;
  if (keys.recoveryAgeIdentity) {
    const recovered = await unsealWithIdentity(ciphertext, keys.recoveryAgeIdentity);
    if (recovered !== null) return recovered;
  }
  return null;
}
