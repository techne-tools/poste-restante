/**
 * The keystore's custody promises — SPEC §15, unit tests.
 *
 * Each test names the negative it proves. "Works for the owner" is not a
 * privacy test (AGENTS.md checklist #8): the interesting assertions are
 * that a wrong passphrase opens nothing, that an altered record opens
 * nothing, and that the age identity is not sitting in localStorage in a
 * form anything can parse.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  KeystoreExistsError,
  KeystoreUnreadableError,
  MIN_PASSPHRASE,
  adoptLegacyKeys,
  backupAt,
  createKeystore,
  exportBackup,
  hasKeystore,
  importBackup,
  isKeystoreUnlocked,
  lockAllKeystores,
  mintRecoveryIdentityFor,
  passphraseProblem,
  preferredKdf,
  recordOf,
  unlockKeystore,
  unlockedKeys,
  wipeKeystore,
} from "./keystore";
import { generateKeys, sealToRecipients, sealToPassphrase, unsealWithIdentity } from "./keys";
import { unsealLetterBody } from "./crypto";

/** The two storage keys the keystore uses. Hardcoded on purpose: a test
 *  that reads them through the module's own constants could not catch a
 *  rename that moved plaintext somewhere new. */
const STORE_KEY = "poste-restante.keystore";
const LEGACY_KEY = "poste-restante.keys";

const PASSPHRASE = "the light in the rehearsal room";
const ADDRESS = "chris@house";

let saved: Storage | undefined;

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

/** Every value in localStorage, as text. */
function allValues(): string[] {
  const ls = globalThis.localStorage;
  const out: string[] = [];
  for (let i = 0; i < ls.length; i++) {
    const k = ls.key(i);
    if (k === null) continue;
    out.push(ls.getItem(k) ?? "");
  }
  return out;
}

function records(): Record<string, unknown> {
  return JSON.parse(globalThis.localStorage.getItem(STORE_KEY) ?? "{}") as Record<string, unknown>;
}

function writeRecords(all: Record<string, unknown>): void {
  globalThis.localStorage.setItem(STORE_KEY, JSON.stringify(all));
}

beforeEach(() => {
  saved = (globalThis as unknown as { localStorage?: Storage }).localStorage;
  Object.defineProperty(globalThis, "localStorage", {
    value: fakeLocalStorage(),
    configurable: true,
  });
  // The vault is module state and outlives a test — always start sealed.
  lockAllKeystores();
});

afterEach(() => {
  lockAllKeystores();
  if (saved !== undefined) {
    Object.defineProperty(globalThis, "localStorage", {
      value: saved,
      configurable: true,
    });
  } else {
    delete (globalThis as Record<string, unknown>).localStorage;
  }
});

describe("wrap / unwrap", () => {
  it("seals the key material and opens it with the same passphrase", async () => {
    const made = await createKeystore(ADDRESS, PASSPHRASE);
    expect(isKeystoreUnlocked(ADDRESS)).toBe(true);

    lockAllKeystores();
    expect(isKeystoreUnlocked(ADDRESS)).toBe(false);
    expect(unlockedKeys(ADDRESS)).toBeNull();

    const opened = await unlockKeystore(ADDRESS, PASSPHRASE);
    expect(opened.ageIdentity).toBe(made.ageIdentity);
    expect(opened.ed25519Private).toBe(made.ed25519Private);
    expect(opened.ed25519Public).toBe(made.ed25519Public);
    expect(opened.recoveryAgeIdentity).toBeNull();
  });

  it("uses Argon2id where the WASM build runs, and records it", async () => {
    const kdf = await preferredKdf();
    // The platform this test runs on has the WASM build; if a future run
    // does not, the fallback is documented and the assertion says so.
    expect(kdf.alg).toBe("argon2id");
    await createKeystore(ADDRESS, PASSPHRASE);
    expect(recordOf(ADDRESS)?.kdf.alg).toBe("argon2id");
  });

  it("round-trips a PBKDF2 record — the documented fallback", async () => {
    await createKeystore(ADDRESS, PASSPHRASE, {
      kdf: { alg: "pbkdf2-sha256", iterations: 1000 },
    });
    expect(recordOf(ADDRESS)?.kdf).toEqual({ alg: "pbkdf2-sha256", iterations: 1000 });
    lockAllKeystores();
    const opened = await unlockKeystore(ADDRESS, PASSPHRASE);
    expect(opened.ageIdentity).toMatch(/^AGE-SECRET-KEY-1/);
  });
});

describe("fails closed", () => {
  it("refuses a wrong passphrase and leaves the session sealed", async () => {
    await createKeystore(ADDRESS, PASSPHRASE);
    lockAllKeystores();

    await expect(unlockKeystore(ADDRESS, "not the passphrase at all")).rejects.toBeInstanceOf(
      KeystoreUnreadableError,
    );
    expect(isKeystoreUnlocked(ADDRESS)).toBe(false);
    expect(unlockedKeys(ADDRESS)).toBeNull();
  });

  it("refuses a tampered payload", async () => {
    await createKeystore(ADDRESS, PASSPHRASE);
    lockAllKeystores();

    const all = records();
    const record = all[ADDRESS] as { payload: string };
    // Flip one character of the ciphertext.
    const i = 20;
    const flipped = record.payload[i] === "A" ? "B" : "A";
    record.payload = record.payload.slice(0, i) + flipped + record.payload.slice(i + 1);
    writeRecords(all);

    await expect(unlockKeystore(ADDRESS, PASSPHRASE)).rejects.toBeInstanceOf(
      KeystoreUnreadableError,
    );
    expect(unlockedKeys(ADDRESS)).toBeNull();
  });

  it("refuses a wrapped key lifted from another address", async () => {
    // Same passphrase for both, so the KEK is the only thing that would
    // have to match — the record's header is authenticated too, and the
    // address is part of it.
    await createKeystore(ADDRESS, PASSPHRASE);
    await createKeystore("sam@house", PASSPHRASE);
    lockAllKeystores();

    const all = records();
    const chris = all[ADDRESS] as { wrappedKey: string };
    const sam = all["sam@house"] as { wrappedKey: string };
    const stolen = chris.wrappedKey;
    chris.wrappedKey = sam.wrappedKey;
    sam.wrappedKey = stolen;
    writeRecords(all);

    await expect(unlockKeystore(ADDRESS, PASSPHRASE)).rejects.toBeInstanceOf(
      KeystoreUnreadableError,
    );
  });

  it("refuses a record copied into another address's slot", async () => {
    await createKeystore(ADDRESS, PASSPHRASE);
    await createKeystore("sam@house", PASSPHRASE);
    lockAllKeystores();

    // The record decrypts with its own address bound in, so it would
    // open — as the wrong resident. The mismatch is refused instead.
    const all = records();
    all["sam@house"] = all[ADDRESS];
    writeRecords(all);

    await expect(unlockKeystore("sam@house", PASSPHRASE)).rejects.toBeInstanceOf(
      KeystoreUnreadableError,
    );
    expect(isKeystoreUnlocked("sam@house")).toBe(false);
  });

  it("refuses to seal keys it could not keep", async () => {
    // A browser withholding storage (private mode, a blocked origin).
    delete (globalThis as Record<string, unknown>).localStorage;

    await expect(createKeystore(ADDRESS, PASSPHRASE)).rejects.toThrow(/will not keep your keys/);
    expect(isKeystoreUnlocked(ADDRESS)).toBe(false);
  });

  it("refuses an edited salt", async () => {
    await createKeystore(ADDRESS, PASSPHRASE);
    lockAllKeystores();

    const all = records();
    const record = all[ADDRESS] as { salt: string };
    record.salt = (record.salt[0] === "A" ? "B" : "A") + record.salt.slice(1);
    writeRecords(all);

    await expect(unlockKeystore(ADDRESS, PASSPHRASE)).rejects.toBeInstanceOf(
      KeystoreUnreadableError,
    );
  });
});

describe("what localStorage holds", () => {
  it("holds no parseable age identity, and no private key field", async () => {
    const keys = await createKeystore(ADDRESS, PASSPHRASE);

    for (const value of allValues()) {
      expect(value).not.toContain("AGE-SECRET-KEY-1");
      expect(value).not.toContain(keys.ageIdentity);
      expect(value).not.toContain(keys.ed25519Private);
      // The old plaintext store is not merely unused — it is gone.
      expect(value).not.toContain('"ed25519Private"');
      expect(value).not.toContain('"ageIdentity"');
    }
  });

  it("keeps only public halves and timing metadata in the clear", async () => {
    const keys = await createKeystore(ADDRESS, PASSPHRASE);
    const record = recordOf(ADDRESS);
    expect(record?.publicHalves.ageRecipient).toBe(keys.ageRecipient);
    expect(record?.publicHalves.ed25519Public).toBe(keys.ed25519Public);
    expect(record?.backupAt).toBeNull();
  });

  it("refuses to mint a second keypair while unsealed keys are here", async () => {
    const legacy = await generateKeys();
    globalThis.localStorage.setItem(LEGACY_KEY, JSON.stringify({ [ADDRESS]: legacy }));

    // Sealing those keys is a different act; a fresh pair would strand
    // the plaintext one.
    await expect(createKeystore(ADDRESS, PASSPHRASE)).rejects.toBeInstanceOf(KeystoreExistsError);
    expect(hasKeystore(ADDRESS)).toBe(false);
  });

  it("seals the old plaintext store on adoption, and removes it", async () => {
    const legacy = await generateKeys();
    globalThis.localStorage.setItem(LEGACY_KEY, JSON.stringify({ [ADDRESS]: legacy }));

    await adoptLegacyKeys(ADDRESS, PASSPHRASE);

    expect(globalThis.localStorage.getItem(LEGACY_KEY)).toBeNull();
    for (const value of allValues()) {
      expect(value).not.toContain("AGE-SECRET-KEY-1");
    }

    lockAllKeystores();
    const opened = await unlockKeystore(ADDRESS, PASSPHRASE);
    expect(opened.ageIdentity).toBe(legacy.ageIdentity);
  });
});

describe("export → wipe → import", () => {
  it("restores keys that still unseal a letter stored before the wipe", async () => {
    const keys = await createKeystore(ADDRESS, PASSPHRASE);

    // A sealed letter, stored while the resident held their key.
    const stored = await sealToRecipients("the archive remembers", [keys.ageRecipient]);
    expect(await unsealWithIdentity(stored, keys.ageIdentity)).toBe("the archive remembers");

    const backup = await exportBackup(ADDRESS, PASSPHRASE);
    expect(backup.filename).toBe("poste-restante-chris@house-keystore.age");
    expect(backup.contents.startsWith("-----BEGIN AGE ENCRYPTED FILE-----")).toBe(true);
    // The file is a standard age file — and it is not plaintext.
    expect(backup.contents).not.toContain(keys.ageIdentity);
    expect(backupAt(ADDRESS)).not.toBeNull();

    // The browser profile is lost.
    await wipeKeystore(ADDRESS);
    expect(hasKeystore(ADDRESS)).toBe(false);
    expect(isKeystoreUnlocked(ADDRESS)).toBe(false);
    expect(await unsealLetterBody(ADDRESS, stored)).toBeNull();

    // The resident restores from the file.
    const restored = await importBackup(backup.contents, PASSPHRASE);
    expect(restored.address).toBe(ADDRESS);
    expect(restored.keys.ageIdentity).toBe(keys.ageIdentity);

    // The letter stored before the wipe opens again.
    expect(await unsealLetterBody(ADDRESS, stored)).toBe("the archive remembers");
  });

  it("carries the recovery identity into the backup", async () => {
    await createKeystore(ADDRESS, PASSPHRASE);
    const minted = await mintRecoveryIdentityFor(ADDRESS);
    expect(minted.keys.recoveryAgeIdentity).toMatch(/^AGE-SECRET-KEY-1/);

    const backup = await exportBackup(ADDRESS, PASSPHRASE);
    await wipeKeystore(ADDRESS);
    const restored = await importBackup(backup.contents, PASSPHRASE);

    expect(restored.keys.recoveryAgeIdentity).toBe(minted.keys.recoveryAgeIdentity);
    expect(restored.keys.recoveryAgeRecipient).toBe(minted.keys.recoveryAgeRecipient);

    // And the recovery recipient still opens a letter sealed to it — the
    // §15 backstop survives the round-trip.
    const sealed = await sealToRecipients("backstop", [restored.keys.recoveryAgeRecipient!]);
    expect(await unsealLetterBody(ADDRESS, sealed)).toBe("backstop");
  });

  it("refuses a backup opened with the wrong passphrase", async () => {
    await createKeystore(ADDRESS, PASSPHRASE);
    const backup = await exportBackup(ADDRESS, PASSPHRASE);
    await wipeKeystore(ADDRESS);

    await expect(importBackup(backup.contents, "wrong passphrase entirely")).rejects.toBeInstanceOf(
      KeystoreUnreadableError,
    );
    expect(hasKeystore(ADDRESS)).toBe(false);
  });

  it("refuses to overwrite keys this browser already holds", async () => {
    await createKeystore(ADDRESS, PASSPHRASE);
    const backup = await exportBackup(ADDRESS, PASSPHRASE);

    await expect(importBackup(backup.contents, PASSPHRASE)).rejects.toBeInstanceOf(
      KeystoreExistsError,
    );
  });

  it("refuses a file that is not a key backup", async () => {
    const notABackup = await sealToPassphrase(
      JSON.stringify({ kind: "something/else", v: 1 }),
      PASSPHRASE,
    );
    await expect(importBackup(notABackup, PASSPHRASE)).rejects.toBeInstanceOf(
      KeystoreUnreadableError,
    );
  });
});

describe("passphrase policy", () => {
  it("refuses a short passphrase at every door", async () => {
    expect(passphraseProblem("short")).toMatch(new RegExp(String(MIN_PASSPHRASE)));
    await expect(createKeystore(ADDRESS, "short")).rejects.toThrow(/at least/);
    await createKeystore(ADDRESS, PASSPHRASE);
    await expect(exportBackup(ADDRESS, "short")).rejects.toThrow(/at least/);
  });

  it("wants a confirmation to match", () => {
    expect(passphraseProblem(PASSPHRASE, PASSPHRASE)).toBeNull();
    expect(passphraseProblem(PASSPHRASE, PASSPHRASE + "x")).toMatch(/differ/);
  });
});
