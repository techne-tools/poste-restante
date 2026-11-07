/**
 * The ed25519 signing key's working copy — SPEC §15, client side.
 *
 * The durable form of the signing key is the pkcs8 that sits inside the
 * passphrase-wrapped keystore (`keystore.ts`). This module turns that
 * into a NON-EXTRACTABLE WebCrypto key and keeps it in IndexedDB, so the
 * running client can sign without the exported private key ever being a
 * value in JavaScript that a script could read, copy or exfiltrate.
 *
 * What that buys, honestly:
 *
 *   - An XSS cannot read the key material out. `subtle.exportKey` fails
 *     on a non-extractable key, and the structured-clone that IDB stores
 *     preserves non-extractability.
 *   - An XSS CAN still ask the browser to sign while the key is present.
 *     A key you can use, you can use badly — there is no in-page defence
 *     against that. What the design does about it: the key is written at
 *     unlock, deleted on lock and on sign-out, and purged at start-up
 *     when nothing is open (a crash cannot leave a signing capability
 *     lying around), and signing is only ever reached through the
 *     unlocked session.
 *   - The age identity has no equivalent. The age library needs the
 *     identity string, so it cannot be a CryptoKey at all; the wrapped
 *     keystore is its only protection. The two halves are not equal and
 *     the UI must not pretend they are.
 *
 * "Where the platform allows" is real: no IndexedDB (or a clone failure)
 * degrades to an in-memory key for the session. Signing still works; the
 * working copy simply is not persisted.
 */

import { importSigningKey } from "./keys";

const DB_NAME = "poste-restante.keystore";
const DB_VERSION = 1;
const STORE = "signing-keys";

/** The session's working keys, by address. Cleared on lock. */
const memory = new Map<string, CryptoKey>();

interface StoredKey {
  address: string;
  /** The ed25519 public (base64url spki) this key belongs to — a guard
   *  against a stale copy from an earlier identity signing as this one. */
  publicKey: string;
  key: CryptoKey;
}

function hasIndexedDb(): boolean {
  return typeof indexedDB !== "undefined" && indexedDB !== null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "address" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error("the keystore database would not open"));
    request.onblocked = () => reject(new Error("the keystore database is blocked"));
  });
}

function idbGet(db: IDBDatabase, address: string): Promise<StoredKey | null> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).get(address);
    req.onsuccess = () => resolve((req.result as StoredKey | undefined) ?? null);
    req.onerror = () => reject(req.error ?? new Error("the keystore database would not read"));
  });
}

function idbPut(db: IDBDatabase, value: StoredKey): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).put(value);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("the keystore database would not write"));
  });
}

function idbDelete(db: IDBDatabase, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).delete(address);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("the keystore database would not forget"));
  });
}

function idbClear(db: IDBDatabase): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    tx.objectStore(STORE).clear();
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error("the keystore database would not forget"));
  });
}

/**
 * The working signing key for an address — from the session cache, then
 * IndexedDB, then (first time, or after a backup restore) imported from
 * the wrapped keystore's pkcs8.
 *
 * Pass `ed25519Public` so a stale persisted key from a different identity
 * is replaced rather than used.
 */
export async function provisionWorkingKey(
  address: string,
  ed25519Private: string,
  ed25519Public: string,
): Promise<CryptoKey> {
  const cached = memory.get(address);
  if (cached) return cached;

  if (hasIndexedDb()) {
    try {
      const db = await openDb();
      try {
        const existing = await idbGet(db, address);
        if (existing && existing.publicKey === ed25519Public) {
          memory.set(address, existing.key);
          return existing.key;
        }
      } finally {
        db.close();
      }
    } catch {
      // IndexedDB refused (private mode, quota, a hostile clone). Fall
      // through to the in-memory key — signing still works, persistence
      // does not.
    }
  }

  const key = await importSigningKey(ed25519Private);
  memory.set(address, key);

  if (hasIndexedDb()) {
    try {
      const db = await openDb();
      try {
        await idbPut(db, { address, publicKey: ed25519Public, key });
      } finally {
        db.close();
      }
    } catch {
      // As above — the session keeps a working key either way.
    }
  }

  return key;
}

/** Forget one address's working key (lock). */
export async function purgeWorkingKey(address: string): Promise<void> {
  memory.delete(address);
  if (!hasIndexedDb()) return;
  try {
    const db = await openDb();
    try {
      await idbDelete(db, address);
    } finally {
      db.close();
    }
  } catch {
    // Nothing to do — memory is already clear, and the durable key is
    // the wrapped pkcs8.
  }
}

/** Forget every working key (sign-out, or start-up with nothing open). */
export async function purgeAllWorkingKeys(): Promise<void> {
  memory.clear();
  if (!hasIndexedDb()) return;
  try {
    const db = await openDb();
    try {
      await idbClear(db);
    } finally {
      db.close();
    }
  } catch {
    // As above.
  }
}

/** The session's working key, if this address is open. Read-only view —
 *  it does not reach IndexedDB. */
export function sessionSigningKey(address: string): CryptoKey | null {
  return memory.get(address) ?? null;
}
