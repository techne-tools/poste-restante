/**
 * The unsealed-letter cache — PLAN-crypto.md E4, client half.
 *
 * Three properties, each tested for the reason it exists:
 *
 *   a hit is served      — a pre-seeded answer wins over a real ciphertext,
 *                          which is only possible if the decrypt was skipped;
 *   the key is specific  — another letter id, or another key generation, is a
 *                          miss, so a cache entry can never answer for a
 *                          letter or a key it was not made for;
 *   a lock empties it    — the plaintext is session-scoped, and locking the
 *                          keystore ends the session.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  createKeystore,
  ensureKeys,
  lockAllKeystores,
  lockKeystore,
  sealToRecipients,
  unsealLetterBody,
} from "./crypto";
import { cacheUnseal, cachedUnseal, forgetUnsealed } from "./unsealedCache";

const ADDRESS = "chris@house";
const PASSPHRASE = "the light in the rehearsal room";

/** The localStorage the keystore writes to. */
const KEYSTORE = (globalThis as unknown as { localStorage?: Storage }).localStorage;

function fakeLocalStorage(): Storage {
  const store = new Map<string, string>();
  return {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => [...store.keys()][i] ?? null,
    get length() {
      return store.size;
    },
  } as Storage;
}

describe("the unsealed-letter cache", () => {
  let saved: Storage | undefined;

  beforeEach(() => {
    lockAllKeystores();
    forgetUnsealed();
    saved = KEYSTORE ?? undefined;
    Object.defineProperty(globalThis, "localStorage", {
      value: fakeLocalStorage(),
      configurable: true,
    });
  });

  afterEach(() => {
    lockAllKeystores();
    forgetUnsealed();
    if (saved !== undefined) {
      Object.defineProperty(globalThis, "localStorage", { value: saved, configurable: true });
    } else {
      delete (globalThis as Record<string, unknown>).localStorage;
    }
  });

  it("serves a cached answer instead of decrypting again", async () => {
    await createKeystore(ADDRESS, PASSPHRASE);
    const keys = ensureKeys(ADDRESS);
    const ciphertext = await sealToRecipients("the real plaintext", [keys.ageRecipient]);
    const letterId = "a".repeat(64);

    // Seed the entry a real decrypt would have written. The sentinel is not
    // what the ciphertext says, so getting it back proves the decrypt was
    // not run.
    const seeded = { ok: true as const, plaintext: "from the cache" };
    cacheUnseal(letterId, keys.ed25519Public, seeded);

    expect(await unsealLetterBody(ADDRESS, ciphertext, letterId)).toEqual(seeded);
  });

  it("writes the entry after a real decrypt", async () => {
    await createKeystore(ADDRESS, PASSPHRASE);
    const keys = ensureKeys(ADDRESS);
    const ciphertext = await sealToRecipients("the real plaintext", [keys.ageRecipient]);
    const letterId = "b".repeat(64);

    const opened = await unsealLetterBody(ADDRESS, ciphertext, letterId);

    expect(opened).toEqual({ ok: true, plaintext: "the real plaintext" });
    expect(cachedUnseal(letterId, keys.ed25519Public)).toEqual(opened);
  });

  it("does not answer for a different letter or a different key generation", async () => {
    await createKeystore(ADDRESS, PASSPHRASE);
    const keys = ensureKeys(ADDRESS);
    const ciphertext = await sealToRecipients("the real plaintext", [keys.ageRecipient]);
    const letterId = "c".repeat(64);

    cacheUnseal(letterId, keys.ed25519Public, { ok: true, plaintext: "for this letter only" });

    // Another letter id: a miss, so the real body is decrypted.
    expect(await unsealLetterBody(ADDRESS, ciphertext, "d".repeat(64))).toEqual({
      ok: true,
      plaintext: "the real plaintext",
    });
    // Another key generation: a miss. Nothing is served across a re-key.
    expect(cachedUnseal(letterId, "some-other-public-key")).toBeUndefined();
  });

  it("never stores 'no_keys' — that is a fact about the keystore, not the letter", async () => {
    // No keystore: the reader is told to open one.
    expect(await unsealLetterBody(ADDRESS, "irrelevant", "e".repeat(64))).toEqual({
      ok: false,
      reason: "no_keys",
    });

    expect(cachedUnseal("e".repeat(64), "fingerprint")).toBeUndefined();

    // And the sentinel form the unseal would have written is refused too.
    cacheUnseal("e".repeat(64), "fingerprint", { ok: false, reason: "no_keys" });
    expect(cachedUnseal("e".repeat(64), "fingerprint")).toBeUndefined();
  });

  it("empties on lock — a locked client holds no unsealed letter", async () => {
    await createKeystore(ADDRESS, PASSPHRASE);
    const keys = ensureKeys(ADDRESS);
    const ciphertext = await sealToRecipients("the real plaintext", [keys.ageRecipient]);
    const letterId = "f".repeat(64);

    expect((await unsealLetterBody(ADDRESS, ciphertext, letterId)).ok).toBe(true);
    expect(cachedUnseal(letterId, keys.ed25519Public)).toBeDefined();

    lockKeystore(ADDRESS);

    expect(cachedUnseal(letterId, keys.ed25519Public)).toBeUndefined();
  });

  it("keeps at most a reading's worth of letters", () => {
    const fingerprint = "fp";
    for (let i = 0; i < 70; i++) {
      cacheUnseal(`letter-${i}`, fingerprint, { ok: true, plaintext: `body ${i}` });
    }

    // The oldest fell out; the newest is there.
    expect(cachedUnseal("letter-0", fingerprint)).toBeUndefined();
    expect(cachedUnseal("letter-69", fingerprint)).toEqual({ ok: true, plaintext: "body 69" });
  });
});
