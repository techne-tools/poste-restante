/**
 * The non-extractable signing key — SPEC §15, unit tests.
 *
 * The claim under test is narrow and worth stating exactly: the working
 * key can sign, and cannot be read out. It is NOT a claim that a script
 * on the page cannot use it — a key you can use, you can use badly. The
 * mitigation is lifecycle (written at unlock, purged on lock), which the
 * last test covers.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { IDBFactory, IDBKeyRange } from "fake-indexeddb";
import {
  provisionWorkingKey,
  purgeAllWorkingKeys,
  sessionSigningKey,
} from "./signingKey";
import { generateKeys, fromBase64url, toBase64url } from "./keys";

const ADDRESS = "chris@house";

let savedIdb: IDBFactory | undefined;
let savedKeyRange: typeof IDBKeyRange | undefined;

beforeEach(() => {
  savedIdb = globalThis.indexedDB;
  savedKeyRange = globalThis.IDBKeyRange;
  Object.defineProperty(globalThis, "indexedDB", {
    value: new IDBFactory(),
    configurable: true,
  });
  Object.defineProperty(globalThis, "IDBKeyRange", {
    value: IDBKeyRange,
    configurable: true,
  });
});

afterEach(async () => {
  await purgeAllWorkingKeys();
  if (savedIdb !== undefined) {
    Object.defineProperty(globalThis, "indexedDB", { value: savedIdb, configurable: true });
  } else {
    delete (globalThis as Record<string, unknown>).indexedDB;
  }
  if (savedKeyRange !== undefined) {
    Object.defineProperty(globalThis, "IDBKeyRange", {
      value: savedKeyRange,
      configurable: true,
    });
  }
});

/** Verify a signature with the key's public half. */
async function verifies(spkiBase64url: string, id: string, signature: string): Promise<boolean> {
  const key = await crypto.subtle.importKey(
    "spki",
    fromBase64url(spkiBase64url),
    { name: "Ed25519" },
    false,
    ["verify"],
  );
  return crypto.subtle.verify(
    "Ed25519",
    key,
    fromBase64url(signature),
    new TextEncoder().encode(id),
  );
}

async function sign(key: CryptoKey, id: string): Promise<string> {
  const sig = await crypto.subtle.sign("Ed25519", key, new TextEncoder().encode(id));
  return toBase64url(new Uint8Array(sig));
}

/** Read the raw IndexedDB record, bypassing the module's cache. */
function readPersisted(address: string): Promise<{ publicKey: string; key: CryptoKey } | null> {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open("poste-restante.keystore", 1);
    open.onerror = () => reject(open.error);
    open.onsuccess = () => {
      const db = open.result;
      const tx = db.transaction("signing-keys", "readonly");
      const req = tx.objectStore("signing-keys").get(address);
      req.onsuccess = () => {
        db.close();
        resolve((req.result as { publicKey: string; key: CryptoKey } | undefined) ?? null);
      };
      req.onerror = () => reject(req.error);
    };
  });
}

describe("the working key", () => {
  it("is non-extractable — it signs, and cannot be read out", async () => {
    const keys = await generateKeys();
    const working = await provisionWorkingKey(ADDRESS, keys.ed25519Private, keys.ed25519Public);

    expect(working.extractable).toBe(false);
    expect(working.usages).toContain("sign");

    const id = "f".repeat(64);
    expect(await verifies(keys.ed25519Public, id, await sign(working, id))).toBe(true);

    // The whole point: no export.
    await expect(crypto.subtle.exportKey("pkcs8", working)).rejects.toBeTruthy();
    await expect(crypto.subtle.exportKey("jwk", working)).rejects.toBeTruthy();
  });

  it("persists to IndexedDB across a page load, still non-extractable", async () => {
    const keys = await generateKeys();
    const first = await provisionWorkingKey(ADDRESS, keys.ed25519Private, keys.ed25519Public);

    // A reload: the module's session cache is gone, the database is not.
    const persisted = await readPersisted(ADDRESS);
    expect(persisted).not.toBeNull();
    expect(persisted!.publicKey).toBe(keys.ed25519Public);
    expect(persisted!.key.extractable).toBe(false);

    // The signature made by the persisted key verifies against the public
    // half — proof it is the same key, not a fresh one.
    const id = "a".repeat(64);
    expect(await verifies(keys.ed25519Public, id, await sign(persisted!.key, id))).toBe(true);
    expect(await sign(first, id)).toBe(await sign(persisted!.key, id));
  });

  it("replaces a stale key belonging to a different identity", async () => {
    const oldKeys = await generateKeys();
    await provisionWorkingKey(ADDRESS, oldKeys.ed25519Private, oldKeys.ed25519Public);

    // A reload: the module's session cache is empty, IndexedDB still
    // holds the old identity's key — and a backup restore then brings a
    // different identity to the same address. The guard is the public
    // half written beside the key.
    vi.resetModules();
    const fresh = await import("./signingKey");
    const newKeys = await generateKeys();
    const working = await fresh.provisionWorkingKey(
      ADDRESS,
      newKeys.ed25519Private,
      newKeys.ed25519Public,
    );

    const id = "b".repeat(64);
    const signature = await sign(working, id);
    expect(await verifies(newKeys.ed25519Public, id, signature)).toBe(true);
    expect(await verifies(oldKeys.ed25519Public, id, signature)).toBe(false);
  });

  it("purges on lock — nothing signs after the session ends", async () => {
    const keys = await generateKeys();
    await provisionWorkingKey(ADDRESS, keys.ed25519Private, keys.ed25519Public);
    expect(sessionSigningKey(ADDRESS)).not.toBeNull();

    await purgeAllWorkingKeys();

    expect(sessionSigningKey(ADDRESS)).toBeNull();
    expect(await readPersisted(ADDRESS)).toBeNull();
  });

  it("degrades to an in-memory key where IndexedDB is absent", async () => {
    delete (globalThis as Record<string, unknown>).indexedDB;

    const keys = await generateKeys();
    const working = await provisionWorkingKey(ADDRESS, keys.ed25519Private, keys.ed25519Public);

    expect(working.extractable).toBe(false);
    const id = "c".repeat(64);
    expect(await verifies(keys.ed25519Public, id, await sign(working, id))).toBe(true);
    expect(sessionSigningKey(ADDRESS)).toBe(working);
  });
});
