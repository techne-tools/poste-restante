/**
 * The resident's cryptography — SPEC §15, client side.
 *
 * The house holds exactly one keypair (its own, a participant key); the
 * resident holds theirs. The material itself is made in `keys.ts` and
 * held in custody by `keystore.ts` — sealed under a passphrase, open only
 * for the session. This module is the letter-facing half: the canonical
 * form, the letter id, the seal, the unseal.
 *
 * The letter id is derived EXACTLY as the server derives it
 * (id.ts::canonicaliseWith + letterIdFromCanonical): sha256 of a
 * canonical JSON serialisation of the zod-parsed letter, with each
 * handle resolved to its identity (the ed25519 public fingerprint, §19;
 * legacy addresses without keys resolve to the handle itself). The
 * client must reproduce that derivation byte-for-byte — a drifted
 * canonical form would make the id never match on the server side and
 * every sealed letter would be rejected at the signature gate. The
 * canonicalise / letterIdFromCanonical pair below is frozen for that
 * reason; custody changes never touch it.
 *
 * Key custody: `keystore.ts`. Nothing here writes a private half to
 * storage directly, and nothing here sends one to the house — this file
 * never transmits key material.
 *
 * This is the in-common that is nothing-in-common, made cryptographic
 * (Nancy): the house shares the with — the letters circulate through it —
 * but the sealed body's substance never passes to the house. Sharing is
 * the circulation, not the pooled content.
 */

import { sealToRecipients, signLetterIdWithKey, importSigningKey, unsealWithIdentity } from "./keys";
import {
  KeystoreAbsentError,
  KeystoreLockedError,
  hasKeystore,
  mintRecoveryIdentityFor,
  signingKeyOf,
  unlockedKeys,
} from "./keystore";
import type { ResidentKeys } from "./keys";

/* The primitives are re-exported here so the module stays the single
 * import for letter crypto; the definitions live in keys.ts. */
export {
  generateKeys,
  sealToRecipients,
  sealToPassphrase,
  unsealWithIdentity,
  unsealWithPassphrase,
  signLetterId,
  signLetterIdWithKey,
} from "./keys";
export type { PublicHalves, ResidentKeys } from "./keys";

/* Custody surface, re-exported for the record view. */
export {
  KeystoreAbsentError,
  KeystoreExistsError,
  KeystoreLockedError,
  KeystoreUnreadableError,
  MIN_PASSPHRASE,
  adoptLegacyKeys,
  backupAt,
  createKeystore,
  exportBackup,
  hasKeystore,
  importBackup,
  isKeystoreUnlocked,
  legacyAddresses,
  lockAllKeystores,
  lockKeystore,
  passphraseProblem,
  publicHalvesOf,
  recordOf,
  storeKeys,
  unlockKeystore,
  unlockedKeys,
  wipeKeystore,
} from "./keystore";

/** The resident's keys for an address, if the keystore is open for this
 *  session. Null when there are none, or when they are sealed. */
export function loadKeys(address: string): ResidentKeys | null {
  return unlockedKeys(address);
}

/** The keys for an address that must be open to continue — sealing a
 *  letter, minting a recovery identity, backing up.
 *
 *  There is no auto-mint any more, and no silent fallback: a keypair
 *  cannot be brought into being without a passphrase to seal it with, so
 *  a resident with no keystore is told to make one, and a sealed one is
 *  told to open it. Both refusals carry the resident-facing copy. */
export function ensureKeys(address: string): ResidentKeys {
  const open = unlockedKeys(address);
  if (open) return open;
  throw hasKeystore(address)
    ? new KeystoreLockedError()
    : new KeystoreAbsentError();
}

/** Mint the recovery age identity — the §15 backstop (see keystore.ts). */
export async function mintRecoveryIdentity(address: string): Promise<{
  keys: ResidentKeys;
  recoveryIdentity: string;
}> {
  return mintRecoveryIdentityFor(address);
}

/** The recovery recipient for an address's key record — used when
 *  registering keys, so the house can serve it to correspondents. */
export function recoveryRecipientOf(keys: ResidentKeys): string | null {
  return keys.recoveryAgeRecipient;
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
 *   1. Read the resident's open keys. The keystore must be unlocked for
 *      this session — a seal is a signing act, and a signing key that
 *      answers without a passphrase is a signing key anyone can use.
 *      (Unlock once per session, not per letter.)
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
 *   5. Sign the id with the writer's ed25519 key — the non-extractable
 *      working key when IndexedDB holds one, else imported from the
 *      wrapped pkcs8.
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
  /** True when this call registered a keypair the house had not seen. */
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
  const keys = ensureKeys(draft.envelope.from);
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
  const signing = signingKeyOf(draft.envelope.from) ?? (await importSigningKey(keys.ed25519Private));
  const signature = await signLetterIdWithKey(id, signing);

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
 * null when the keystore is sealed, when the resident is not a recipient
 * (wrong key), or when the armor is malformed. The envelope is always
 * visible; the body waits.
 *
 * Fallback: when the primary age identity fails (lost — the §15 case),
 * the resident's recovery identity is tried. The house never holds the
 * recovery private half; it lives with the resident, off-box, and in
 * this keystore so a lost session can be recovered.
 *
 * A null return does not say why — callers that want to distinguish
 * "sealed keystore" from "not a recipient" check `isKeystoreUnlocked`.
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
