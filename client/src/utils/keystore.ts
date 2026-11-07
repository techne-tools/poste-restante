/**
 * The resident's keystore custody — SPEC §15, client side.
 *
 * The private halves live in the browser and nowhere else; the house
 * holds only public halves (SPEC §19). That leaves one question this
 * module answers: what does an attacker with a script on the page get?
 *
 * Before: everything. `localStorage["poste-restante.keys"]` was plain
 * JSON — every age identity, the ed25519 private key, and the recovery
 * identity that was meant to be the backstop against losing them. A
 * sealed letter is only as private as the weakest script on the page.
 *
 * Now: a passphrase-wrapped record. The passphrase is stretched with
 * Argon2id (WASM) and, where the platform cannot run it, PBKDF2-SHA256
 * at 600k iterations; the stretched key wraps a random 256-bit data key
 * with AES-KW; the data key encrypts the key material with AES-GCM. The
 * record header is bound in as AAD, so a wrapped key lifted from another
 * address — or a salt or KDF parameter edited to weaken the derivation —
 * fails to open instead of opening wrongly.
 *
 * Why the data key: WebCrypto's AES-KW is RFC 3394, which has no padding
 * and only wraps CryptoKeys. An age identity is a 74-byte string and a
 * pkcs8 is variable-length, so neither can be handed to `wrapKey`
 * directly. Wrapping a 256-bit data key is what AES-KW is actually for;
 * AES-GCM then handles the variable-length material and brings its own
 * integrity tag. The card's "AES-KW over the age identity and the
 * ed25519 pkcs8" is satisfied one level down: the KEK wraps the key that
 * seals them, and no secret is ever at rest outside ciphertext.
 *
 * Nothing here is a server feature. The house never holds a private key,
 * never sees the passphrase, and has no decryption path. The passphrase
 * is used to derive a key and is not retained; the unwrapped data key
 * and the key material live in memory for the session and are cleared on
 * lock and on sign-out.
 *
 * What this does not do: an XSS that runs while the keystore is open can
 * read what is open (that is what "open" means), and can ask the browser
 * to sign with the non-extractable ed25519 working key. It cannot read
 * the signing key out of the browser, and it cannot open a sealed record
 * without the passphrase. Say it that way in the UI — do not imply a
 * sandbox that is not there.
 */

import {
  generateKeys,
  mintRecoveryPair,
  sealToPassphrase,
  toBase64url,
  unsealWithPassphrase,
  type PublicHalves,
  type ResidentKeys,
} from "./keys";
import {
  provisionWorkingKey,
  purgeAllWorkingKeys,
  purgeWorkingKey,
} from "./signingKey";

/** v2 — the wrapped keystore. */
const STORE_KEY = "poste-restante.keystore";
/** v1 — the plaintext store this replaces. Read once, migrated, removed. */
const LEGACY_KEY = "poste-restante.keys";

/** Argon2id, OWASP's second listed option (64 MiB, t=3, p=1) — about
 *  100 ms in the WASM build. Memory cost is what makes the derivation
 *  resistant to GPU cracking; time cost alone is not. */
const ARGON2 = { alg: "argon2id", m: 65536, t: 3, p: 1 } as const;
/** The documented fallback where Argon2id cannot run at all. */
const PBKDF2_ITERATIONS = 600_000;
const SALT_BYTES = 16;
const IV_BYTES = 12;

/** The shortest passphrase we will seal with. Long is what matters; a
 *  line the resident can remember beats a random string they write on a
 *  sticky note. */
export const MIN_PASSPHRASE = 12;

export type KdfSpec =
  | { alg: "argon2id"; m: number; t: number; p: number }
  | { alg: "pbkdf2-sha256"; iterations: number };

/** The sealed record, one per address. Everything a secret is inside
 *  `payload`; the rest is either public (the house holds the public
 *  halves anyway) or needed to derive the key. */
export interface SealedRecord {
  v: 2;
  address: string;
  kdf: KdfSpec;
  /** base64, 16 random bytes — per record, never reused. */
  salt: string;
  /** base64 — AES-KW(KEK) over the record's 256-bit data key. */
  wrappedKey: string;
  /** base64, 12 bytes, fresh on every write (AES-GCM). */
  iv: string;
  /** base64 — AES-GCM(DEK) over the key material JSON. */
  payload: string;
  /** Public halves, in the clear: the house holds them, and showing them
   *  must not require the passphrase. */
  publicHalves: PublicHalves;
  /** When a backup file was last written. Plaintext on purpose: the
   *  "this browser holds the only copy" notice has to be readable while
   *  the keystore is sealed. An attacker who can edit the store can also
   *  suppress the reminder — it is a memory aid, not a control. */
  backupAt: string | null;
  createdAt: string;
}

/* ── The refusals ───────────────────────────────────────────────────────── */

/** There are keys, but they are sealed. */
export class KeystoreLockedError extends Error {
  constructor(
    message = "your keys are sealed — open them in your record before sealing a letter",
  ) {
    super(message);
    this.name = "KeystoreLockedError";
  }
}

/** This browser has never held keys for the address. */
export class KeystoreAbsentError extends Error {
  constructor(
    message = "this browser holds no keys yet — make them in your record first",
  ) {
    super(message);
    this.name = "KeystoreAbsentError";
  }
}

/** Wrong passphrase, tampered record, or a format this client cannot
 *  read. Deliberately one error: the house does not distinguish "wrong
 *  key" from "no key" anywhere else, and neither should the keystore
 *  tell a guesser which of the two they achieved. */
export class KeystoreUnreadableError extends Error {
  constructor(
    message = "that passphrase did not open your keys — or the store has been altered",
  ) {
    super(message);
    this.name = "KeystoreUnreadableError";
  }
}

/** An import would replace keys this browser already holds. */
export class KeystoreExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "KeystoreExistsError";
  }
}

/* ── Storage ────────────────────────────────────────────────────────────── */

function storage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // A browser can refuse the property outright (blocked cookies).
    return null;
  }
}

function readAll(): Record<string, SealedRecord> {
  const raw = storage()?.getItem(STORE_KEY);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, SealedRecord> = {};
    for (const [address, record] of Object.entries(parsed as Record<string, unknown>)) {
      if (isSealedRecord(record)) out[address] = record;
    }
    return out;
  } catch {
    return {};
  }
}

function writeAll(all: Record<string, SealedRecord>): void {
  const store = storage();
  // A browser that will not keep the record must say so, and the write
  // must fail — a keystore that exists only in memory until the tab
  // closes would be the worst of both worlds.
  if (!store) {
    throw new Error("this browser will not keep your keys — storage is unavailable or being withheld");
  }
  try {
    store.setItem(STORE_KEY, JSON.stringify(all));
  } catch {
    throw new Error("this browser will not keep your keys — storage is full or blocked");
  }
}

function isSealedRecord(value: unknown): value is SealedRecord {
  if (!value || typeof value !== "object") return false;
  // Deliberately lenient: anything claiming to be a v2 record stays in
  // the store so that a damaged one fails closed at unlock. Dropping it
  // here would make a tampered keystore look like "no keys", and the
  // next create would quietly overwrite what an attacker left behind.
  return (value as Record<string, unknown>).v === 2;
}

/* ── The key derivation ─────────────────────────────────────────────────── */

let argon2Module: typeof import("hash-wasm") | null | undefined;

/** Argon2id from the WASM build, or null where it cannot load. Probed
 *  once; a platform that fails here falls back for the rest of the
 *  session rather than retrying on every unlock. */
async function argon2(): Promise<typeof import("hash-wasm") | null> {
  if (argon2Module !== undefined) return argon2Module;
  try {
    argon2Module = await import("hash-wasm");
  } catch {
    argon2Module = null;
  }
  return argon2Module;
}

/** The KDF a fresh record should use. */
export async function preferredKdf(): Promise<KdfSpec> {
  return (await argon2()) ? { ...ARGON2 } : { alg: "pbkdf2-sha256", iterations: PBKDF2_ITERATIONS };
}

function kdfTag(spec: KdfSpec): string {
  return spec.alg === "argon2id"
    ? `argon2id|m=${spec.m},t=${spec.t},p=${spec.p}`
    : `pbkdf2-sha256|i=${spec.iterations}`;
}

/** What the record authenticates: the version, the address it belongs
 *  to, and the derivation parameters. Changing any of them changes the
 *  AES-GCM AAD, so the record stops opening. */
function aad(address: string, spec: KdfSpec, salt: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(
    `poste-restante/keystore/2|${address}|${kdfTag(spec)}|${salt}`,
  );
}

async function deriveKek(
  passphrase: string,
  salt: Uint8Array<ArrayBuffer>,
  spec: KdfSpec,
): Promise<CryptoKey> {
  let bytes: Uint8Array<ArrayBuffer>;
  if (spec.alg === "argon2id") {
    const mod = await argon2();
    if (!mod) throw new Error("argon2id is not available in this browser");
    bytes = new Uint8Array(
      await mod.argon2id({
        password: passphrase,
        salt,
        parallelism: spec.p,
        iterations: spec.t,
        memorySize: spec.m,
        hashLength: 32,
        outputType: "binary",
      }),
    );
  } else {
    const base = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(passphrase),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      { name: "PBKDF2", hash: "SHA-256", salt, iterations: spec.iterations },
      base,
      256,
    );
    bytes = new Uint8Array(bits);
  }
  return crypto.subtle.importKey("raw", bytes, "AES-KW", false, ["wrapKey", "unwrapKey"]);
}

function randomBytes(n: number): Uint8Array<ArrayBuffer> {
  const out = new Uint8Array(n);
  crypto.getRandomValues(out);
  return out;
}

/* ── Seal and unseal a record ───────────────────────────────────────────── */

/** The secret half of a record, as it goes into the encrypted payload. */
interface SecretPayload {
  ageIdentity: string;
  ed25519Private: string;
  recoveryAgeIdentity: string | null;
}

function payloadOf(keys: ResidentKeys): SecretPayload {
  return {
    ageIdentity: keys.ageIdentity,
    ed25519Private: keys.ed25519Private,
    recoveryAgeIdentity: keys.recoveryAgeIdentity,
  };
}

function halvesOf(keys: ResidentKeys): PublicHalves {
  return {
    ageRecipient: keys.ageRecipient,
    ed25519Public: keys.ed25519Public,
    recoveryAgeRecipient: keys.recoveryAgeRecipient,
  };
}

/** Encrypt the secret payload under a data key. */
async function encryptPayload(
  dek: CryptoKey,
  keys: ResidentKeys,
  address: string,
  spec: KdfSpec,
  salt: string,
): Promise<{ iv: string; payload: string }> {
  const iv = randomBytes(IV_BYTES);
  const ciphertext = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv, additionalData: aad(address, spec, salt) },
    dek,
    new TextEncoder().encode(JSON.stringify(payloadOf(keys))),
  );
  return { iv: toBase64url(iv), payload: toBase64url(new Uint8Array(ciphertext)) };
}

/** Derive a fresh KEK and data key, and write the record. */
async function sealWithPassphrase(
  address: string,
  keys: ResidentKeys,
  passphrase: string,
  kdf?: KdfSpec,
): Promise<{ record: SealedRecord; dek: CryptoKey }> {
  const spec = kdf ?? (await preferredKdf());
  const saltBytes = randomBytes(SALT_BYTES);
  const salt = toBase64url(saltBytes);

  let kek: CryptoKey;
  let usedSpec: KdfSpec = spec;
  try {
    kek = await deriveKek(passphrase, saltBytes, spec);
  } catch (err) {
    // Argon2 said it was there and then could not run (a stripped WASM
    // build, a policy-blocked WebAssembly). The fallback is documented,
    // and a record that cannot be derived is a record that cannot be
    // read — so fall back rather than write it.
    if (spec.alg !== "argon2id") throw err;
    usedSpec = { alg: "pbkdf2-sha256", iterations: PBKDF2_ITERATIONS };
    kek = await deriveKek(passphrase, saltBytes, usedSpec);
  }

  const dek = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, [
    "encrypt",
    "decrypt",
  ]);
  const wrappedKey = await crypto.subtle.wrapKey("raw", dek, kek, "AES-KW");
  const { iv, payload } = await encryptPayload(dek, keys, address, usedSpec, salt);

  // The data key is re-imported as non-extractable for the session: the
  // extractable handle was needed only to wrap it.
  const sessionDek = await crypto.subtle.importKey(
    "raw",
    await crypto.subtle.exportKey("raw", dek),
    { name: "AES-GCM" },
    false,
    ["encrypt", "decrypt"],
  );

  const record: SealedRecord = {
    v: 2,
    address,
    kdf: usedSpec,
    salt,
    wrappedKey: toBase64url(new Uint8Array(wrappedKey)),
    iv,
    payload,
    publicHalves: halvesOf(keys),
    backupAt: null,
    createdAt: new Date().toISOString(),
  };
  return { record, dek: sessionDek };
}

/** Open a record's secret payload. Throws `KeystoreUnreadableError` for a
 *  wrong passphrase or any alteration — AES-KW's integrity check fails on
 *  a changed wrapped key, and AES-GCM's tag fails on changed ciphertext,
 *  changed AAD, or a changed IV. */
async function openRecord(
  record: SealedRecord,
  passphrase: string,
): Promise<{ keys: ResidentKeys; dek: CryptoKey }> {
  let kek: CryptoKey;
  try {
    kek = await deriveKek(passphrase, fromBase64(record.salt), record.kdf);
  } catch (err) {
    // Argon2 unavailable on this platform and the record needs it: that
    // is a read failure, not a wrong passphrase, but it still fails
    // closed rather than guessing.
    throw new KeystoreUnreadableError(
      err instanceof Error && /argon/i.test(err.message)
        ? "this browser cannot run Argon2id, which this keystore needs"
        : undefined,
    );
  }

  let dek: CryptoKey;
  try {
    dek = await crypto.subtle.unwrapKey(
      "raw",
      fromBase64(record.wrappedKey),
      kek,
      "AES-KW",
      { name: "AES-GCM" },
      false,
      ["encrypt", "decrypt"],
    );
  } catch {
    throw new KeystoreUnreadableError();
  }

  let plaintext: ArrayBuffer;
  try {
    plaintext = await crypto.subtle.decrypt(
      {
        name: "AES-GCM",
        iv: fromBase64(record.iv),
        additionalData: aad(record.address, record.kdf, record.salt),
      },
      dek,
      fromBase64(record.payload),
    );
  } catch {
    throw new KeystoreUnreadableError();
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(plaintext));
  } catch {
    throw new KeystoreUnreadableError();
  }
  return { keys: keysFromPayload(parsed, record), dek };
}

function fromBase64(s: string): Uint8Array<ArrayBuffer> {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (s.length % 4)) % 4);
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** Shape-check what came out of the ciphertext. A record that decrypts
 *  but does not look like key material is a failure, not a keystore. */
function keysFromPayload(parsed: unknown, record: SealedRecord): ResidentKeys {
  if (!parsed || typeof parsed !== "object") throw new KeystoreUnreadableError();
  const p = parsed as Record<string, unknown>;
  const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;
  const nullableStr = (v: unknown): v is string | null => v === null || str(v);

  if (
    !str(p.ageIdentity) ||
    !p.ageIdentity.startsWith("AGE-SECRET-KEY-1") ||
    !str(p.ed25519Private) ||
    !nullableStr(p.recoveryAgeIdentity) ||
    (p.recoveryAgeIdentity !== null && !p.recoveryAgeIdentity.startsWith("AGE-SECRET-KEY-1"))
  ) {
    throw new KeystoreUnreadableError();
  }

  return {
    ageIdentity: p.ageIdentity,
    ageRecipient: record.publicHalves.ageRecipient,
    ed25519Private: p.ed25519Private,
    ed25519Public: record.publicHalves.ed25519Public,
    recoveryAgeIdentity: p.recoveryAgeIdentity,
    recoveryAgeRecipient: record.publicHalves.recoveryAgeRecipient,
  };
}

/* ── The session vault ──────────────────────────────────────────────────── */

interface VaultEntry {
  keys: ResidentKeys;
  /** The record's data key, non-extractable, held in memory only — it is
   *  what lets an update re-seal without asking for the passphrase again.
   *  The passphrase itself is never retained. */
  dek: CryptoKey;
  /** The non-extractable ed25519 working key (see `signingKey.ts`). */
  signing: CryptoKey;
}

const vault = new Map<string, VaultEntry>();

/** Is this address's keystore open for the session? */
export function isKeystoreUnlocked(address: string): boolean {
  return vault.has(address);
}

/** The open keys for an address, or null. Never touches storage. */
export function unlockedKeys(address: string): ResidentKeys | null {
  return vault.get(address)?.keys ?? null;
}

/** The session's non-extractable ed25519 working key, or null when the
 *  keystore is sealed. */
export function signingKeyOf(address: string): CryptoKey | null {
  return vault.get(address)?.signing ?? null;
}

/** Drop an address's open keys, and the non-extractable working copy.
 *  Synchronous for the caller; the IndexedDB cleanup finishes after. */
export function lockKeystore(address: string): void {
  vault.delete(address);
  void purgeWorkingKey(address);
}

/** Drop everything — sign-out, or start-up with nothing open. Also
 *  clears any working signing key a previous session (or a crash) left in
 *  IndexedDB, so an unopened client holds no signing capability. */
export function lockAllKeystores(): void {
  vault.clear();
  void purgeAllWorkingKeys();
}

/* ── Reading the store without the passphrase ───────────────────────────── */

/** Is there a sealed record for this address? */
export function hasKeystore(address: string): boolean {
  return Boolean(readAll()[address]);
}

/** The record's cleartext metadata — public halves, timestamps. Useful
 *  while sealed; the secrets are not here. */
export function recordOf(address: string): SealedRecord | null {
  return readAll()[address] ?? null;
}

/** When a backup was last written, or null — drives the resident-facing
 *  "this browser holds the only copy" notice. */
export function backupAt(address: string): string | null {
  return readAll()[address]?.backupAt ?? null;
}

/** The public halves for an address: from the open keys where they are
 *  open, else from the sealed record's cleartext. */
export function publicHalvesOf(address: string): PublicHalves | null {
  const open = vault.get(address);
  if (open) return halvesOf(open.keys);
  return readAll()[address]?.publicHalves ?? null;
}

/* ── The v1 plaintext store — read once, migrate, remove ────────────────── */

/** Addresses whose keys are still in the old plaintext store. */
export function legacyAddresses(): string[] {
  const raw = storage()?.getItem(LEGACY_KEY);
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return [];
    return Object.entries(parsed as Record<string, unknown>)
      .filter(([, v]) => v && typeof v === "object")
      .map(([address]) => address);
  } catch {
    return [];
  }
}

function readLegacy(address: string): ResidentKeys | null {
  const raw = storage()?.getItem(LEGACY_KEY);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const entry = parsed[address];
    return isLegacyKeys(entry) ? entry : null;
  } catch {
    return null;
  }
}

function isLegacyKeys(value: unknown): value is ResidentKeys {
  if (!value || typeof value !== "object") return false;
  const k = value as Record<string, unknown>;
  const str = (v: unknown) => typeof v === "string" && v.length > 0;
  const nullableStr = (v: unknown) => v === null || str(v);
  return (
    str(k.ageIdentity) &&
    str(k.ageRecipient) &&
    str(k.ed25519Private) &&
    str(k.ed25519Public) &&
    nullableStr(k.recoveryAgeIdentity) &&
    nullableStr(k.recoveryAgeRecipient)
  );
}

function removeLegacy(address: string): void {
  const raw = storage()?.getItem(LEGACY_KEY);
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    delete parsed[address];
    if (Object.keys(parsed).length === 0) storage()?.removeItem(LEGACY_KEY);
    else storage()?.setItem(LEGACY_KEY, JSON.stringify(parsed));
  } catch {
    // A store we cannot parse is not a store we can trust; removing the
    // whole key is the safe move once its contents have been adopted.
    storage()?.removeItem(LEGACY_KEY);
  }
}

/* ── The operations ─────────────────────────────────────────────────────── */

/** Seal the keys already in this browser's plaintext store under a
 *  passphrase, and remove the plaintext. This is the migration path for
 *  a resident who used the client before the keystore was sealed. */
export async function adoptLegacyKeys(
  address: string,
  passphrase: string,
): Promise<ResidentKeys> {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);

  const legacy = readLegacy(address);
  if (!legacy) throw new KeystoreAbsentError();
  if (readAll()[address]) {
    throw new KeystoreExistsError(
      `this browser already holds sealed keys for ${address} — open them instead`,
    );
  }

  const { record, dek } = await sealWithPassphrase(address, legacy, passphrase);
  const all = readAll();
  all[address] = record;
  writeAll(all);
  removeLegacy(address);

  const signing = await provisionWorkingKey(address, legacy.ed25519Private, legacy.ed25519Public);
  vault.set(address, { keys: legacy, dek, signing });
  return legacy;
}

/** Make a new keypair, seal it under the passphrase, and open the
 *  session. The public halves are not registered here — the client
 *  registers them at first seal (or from the record), which is the
 *  existing idempotent path. */
export async function createKeystore(
  address: string,
  passphrase: string,
  opts?: { kdf?: KdfSpec; keys?: ResidentKeys },
): Promise<ResidentKeys> {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new Error(problem);

  const all = readAll();
  if (all[address]) {
    throw new KeystoreExistsError(
      `this browser already holds sealed keys for ${address} — open them, or wipe them first`,
    );
  }
  if (readLegacy(address)) {
    // Plaintext keys already here: sealing them is a different act, and
    // silently minting a second keypair would strand the old one.
    throw new KeystoreExistsError(
      `this browser already holds unsealed keys for ${address} — seal those instead`,
    );
  }

  const keys = opts?.keys ?? (await generateKeys());
  const { record, dek } = await sealWithPassphrase(address, keys, passphrase, opts?.kdf);
  all[address] = record;
  writeAll(all);

  const signing = await provisionWorkingKey(address, keys.ed25519Private, keys.ed25519Public);
  vault.set(address, { keys, dek, signing });
  return keys;
}

/** Open a sealed keystore for the session. Wrong passphrase and
 *  tampering both fail closed with `KeystoreUnreadableError`; nothing is
 *  written, and the session stays locked. */
export async function unlockKeystore(
  address: string,
  passphrase: string,
): Promise<ResidentKeys> {
  const record = readAll()[address];
  if (!record) throw new KeystoreAbsentError();
  if (record.address !== address) {
    // A record copied into another address's slot would decrypt with its
    // own address bound in — and open as the wrong resident. Refuse the
    // mismatch before anything is unlocked.
    throw new KeystoreUnreadableError("this record does not belong to this address");
  }

  const { keys, dek } = await openRecord(record, passphrase);
  const signing = await provisionWorkingKey(address, keys.ed25519Private, keys.ed25519Public);
  vault.set(address, { keys, dek, signing });
  return keys;
}

/** Update the open keys and re-seal the record. Requires an unlocked
 *  session: the data key is in memory, the passphrase is not. */
export async function storeKeys(address: string, keys: ResidentKeys): Promise<void> {
  const open = vault.get(address);
  if (!open) throw new KeystoreLockedError();
  const record = readAll()[address];
  if (!record) throw new KeystoreAbsentError();

  const { iv, payload } = await encryptPayload(
    open.dek,
    keys,
    address,
    record.kdf,
    record.salt,
  );
  const next: SealedRecord = {
    ...record,
    iv,
    payload,
    publicHalves: halvesOf(keys),
  };
  const all = readAll();
  all[address] = next;
  writeAll(all);
  vault.set(address, { ...open, keys });
}

/** Mint the recovery age identity — the §15 backstop. The private half
 *  is shown once and held off-box by the resident; the public recipient
 *  is registered with the house. Returns the updated keys and the plain
 *  identity, for the one-time reveal.
 *
 *  Requires an open keystore: the identity is minted into the sealed
 *  record, so the reveal is a deliberate act while the resident holds
 *  the passphrase. */
export async function mintRecoveryIdentityFor(
  address: string,
): Promise<{ keys: ResidentKeys; recoveryIdentity: string }> {
  const current = vault.get(address)?.keys;
  if (!current) {
    throw hasKeystore(address) ? new KeystoreLockedError() : new KeystoreAbsentError();
  }
  if (current.recoveryAgeIdentity && current.recoveryAgeRecipient) {
    // Idempotent — a recovery identity already exists; re-show it.
    return { keys: current, recoveryIdentity: current.recoveryAgeIdentity };
  }
  const pair = await mintRecoveryPair();
  const next: ResidentKeys = {
    ...current,
    recoveryAgeIdentity: pair.identity,
    recoveryAgeRecipient: pair.recipient,
  };
  await storeKeys(address, next);
  return { keys: next, recoveryIdentity: pair.identity };
}

/** Forget this address in this browser: the sealed record, the open
 *  session, the non-extractable working key. The keys still exist in any
 *  backup file the resident exported — and nowhere else. */
export async function wipeKeystore(address: string): Promise<void> {
  const all = readAll();
  delete all[address];
  writeAll(all);
  vault.delete(address);
  await purgeWorkingKey(address);
}

/* ── Backup files ───────────────────────────────────────────────────────── */

const BACKUP_KIND = "poste-restante/keystore-backup";

interface BackupPayload {
  kind: typeof BACKUP_KIND;
  v: 1;
  address: string;
  exportedAt: string;
  keys: ResidentKeys;
}

/** Write a passphrase-protected backup: a standard age file (scrypt
 *  recipient) holding the age identity, the recovery identity, and the
 *  ed25519 pkcs8. Any age implementation can open it — a resident is
 *  never dependent on this client to read their own backup.
 *
 *  Requires an open keystore. The backup passphrase may differ from the
 *  keystore passphrase; nothing about it is stored. */
export async function exportBackup(
  address: string,
  backupPassphrase: string,
): Promise<{ filename: string; contents: string }> {
  const problem = passphraseProblem(backupPassphrase);
  if (problem) throw new Error(problem);

  const keys = vault.get(address)?.keys;
  if (!keys) {
    throw hasKeystore(address) ? new KeystoreLockedError() : new KeystoreAbsentError();
  }

  const payload: BackupPayload = {
    kind: BACKUP_KIND,
    v: 1,
    address,
    exportedAt: new Date().toISOString(),
    keys,
  };
  const contents = await sealToPassphrase(JSON.stringify(payload, null, 2), backupPassphrase);

  const record = readAll()[address];
  if (record) {
    const all = readAll();
    all[address] = { ...record, backupAt: payload.exportedAt };
    writeAll(all);
  }

  const safe = address.replace(/[^A-Za-z0-9._@-]/g, "_");
  return { filename: `poste-restante-${safe}-keystore.age`, contents };
}

/** Read a backup file and seal it into this browser under a passphrase
 *  (default: the backup's own, so one passphrase is enough for a
 *  restore). Refuses to overwrite keys this browser already holds. */
export async function importBackup(
  contents: string,
  backupPassphrase: string,
  opts?: { storePassphrase?: string; overwrite?: boolean },
): Promise<{ address: string; keys: ResidentKeys }> {
  const plaintext = await unsealWithPassphrase(contents, backupPassphrase);
  if (plaintext === null) {
    throw new KeystoreUnreadableError("that passphrase did not open this backup file");
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext);
  } catch {
    throw new KeystoreUnreadableError("this file is not a Poste Restante key backup");
  }

  const backup = parsed as Partial<BackupPayload>;
  if (
    backup.kind !== BACKUP_KIND ||
    backup.v !== 1 ||
    typeof backup.address !== "string" ||
    !isLegacyKeys(backup.keys)
  ) {
    throw new KeystoreUnreadableError("this file is not a Poste Restante key backup");
  }

  const address = backup.address;
  const keys = backup.keys;
  const storePassphrase = opts?.storePassphrase ?? backupPassphrase;
  const problem = passphraseProblem(storePassphrase);
  if (problem) throw new Error(problem);

  if (hasKeystore(address) && !opts?.overwrite) {
    throw new KeystoreExistsError(
      `this browser already holds keys for ${address} — wipe them first if you mean to replace them`,
    );
  }

  const { record, dek } = await sealWithPassphrase(address, keys, storePassphrase);
  const all = readAll();
  all[address] = { ...record, backupAt: backup.exportedAt ?? record.createdAt };
  writeAll(all);

  const signing = await provisionWorkingKey(address, keys.ed25519Private, keys.ed25519Public);
  vault.set(address, { keys, dek, signing });
  return { address, keys };
}

/* ── Passphrase policy ──────────────────────────────────────────────────── */

/** What is wrong with a passphrase, or null. Shared by every surface that
 *  takes one, so the rule lives in one place. */
export function passphraseProblem(
  passphrase: string,
  confirmation?: string,
): string | null {
  if (passphrase.length < MIN_PASSPHRASE) {
    return `use at least ${MIN_PASSPHRASE} characters — a line you can remember is better than one you have to write down`;
  }
  if (confirmation !== undefined && passphrase !== confirmation) {
    return "the two passphrases differ";
  }
  return null;
}
