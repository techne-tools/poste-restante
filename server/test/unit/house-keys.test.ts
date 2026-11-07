/**
 * HouseKeysService — the house's own keypair (SPEC §15, second model),
 * hermetic unit tests.
 *
 * These prove the custody split without infra (PLAN-crypto.md C2): the
 * database holds the public halves, the secret store holds the private ones,
 * the two must belong to each other, and a house that cannot assemble its
 * keypair refuses rather than mints.
 *
 * The acceptance case lives in "a restored database without the secret": the
 * whole point of moving the private halves out of Postgres is that a dump of
 * the database alone does not open a collaborative letter — and that sealed
 * letters never depended on the house key at all.
 */
import { describe, it, expect } from "vitest";
import {
  HouseKeysService,
  HOUSE_ADDRESS,
  HOUSE_AGE_IDENTITY_ENV,
  HOUSE_ED25519_PRIVATE_ENV,
  HouseKeyMissingError,
  HouseKeyMismatchError,
} from "../../src/house/keys.js";
import {
  ed25519PublicOf,
  generateHouseKeypair,
  generateResidentKeypair,
  sealToRecipients,
  unsealWithIdentity,
  type HouseKeypair,
} from "../../src/crypto/keys.js";

/** The shape of `house_keys` after migration 030 — private columns nullable. */
interface HouseRow {
  age_recipient: string;
  ed25519_public: string;
  age_identity: string | null;
  ed25519_private: string | null;
}

interface Recorded {
  sql: string;
  params?: unknown[];
}

/**
 * A pool that behaves like the singleton table. It answers the public-column
 * SELECT, the legacy private-column SELECT, the INSERT and the UPDATE, so a
 * test can tell which of them the service actually asks for.
 */
function fakePool(initial: HouseRow | null = null) {
  let row: HouseRow | null = initial;
  const queries: Recorded[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      if (sql.includes("INSERT INTO addresses") || sql.includes("INSERT INTO address_keys")) {
        return { rows: [] };
      }
      if (sql.includes("UPDATE house_keys")) {
        if (row) row = { ...row, age_identity: null, ed25519_private: null };
        return { rows: [] };
      }
      if (sql.includes("INSERT INTO house_keys")) {
        const [ageRecipient, ed25519Public] = params ?? [];
        if (!row) {
          row = {
            age_recipient: String(ageRecipient),
            ed25519_public: String(ed25519Public),
            age_identity: null,
            ed25519_private: null,
          };
        }
        return { rows: [] };
      }
      if (sql.includes("FROM house_keys")) {
        if (!row) return { rows: [] };
        // The serving path asks for the public columns; only the upgrade path
        // names a private one. Return the projection the SQL asked for.
        return {
          rows: [
            sql.includes("age_identity")
              ? { ...row }
              : { age_recipient: row.age_recipient, ed25519_public: row.ed25519_public },
          ],
        };
      }
      return { rows: [] };
    },
  };
  return { pool: pool as never, queries, current: (): HouseRow | null => row };
}

const noopLog = { info: () => {}, warn: () => {}, error: () => {} } as never;

const envOf = (key: HouseKeypair | null): NodeJS.ProcessEnv =>
  key
    ? { [HOUSE_AGE_IDENTITY_ENV]: key.ageIdentity, [HOUSE_ED25519_PRIVATE_ENV]: key.ed25519Private }
    : {};

/** A database restored from backup: the row is there, the secret store is not. */
const restoredRow = (key: HouseKeypair): HouseRow => ({
  age_recipient: key.ageRecipient,
  ed25519_public: key.ed25519Public,
  age_identity: null,
  ed25519_private: null,
});

const insertedHouseKeys = (queries: Recorded[]): Recorded[] =>
  queries.filter((q) => q.sql.includes("INSERT INTO house_keys"));

describe("HouseKeysService — no key, no house", () => {
  it("returns null when the house has no keypair at all", async () => {
    const { pool } = fakePool();
    const s = new HouseKeysService(pool, noopLog, {});
    expect(await s.get()).toBeNull();
    expect(await s.publicHalves()).toBeNull();
  });

  it("refuses to mint when the row is absent — no silent re-provisioning", async () => {
    const { pool, queries } = fakePool();
    const s = new HouseKeysService(pool, noopLog, {});

    await expect(s.ensure()).rejects.toBeInstanceOf(HouseKeyMissingError);
    // The refusal is structural: nothing was written, so a restored database
    // cannot acquire a new identity simply by starting up.
    expect(insertedHouseKeys(queries)).toHaveLength(0);
  });

  it("refuses to boot when the row exists but the secret store is empty", async () => {
    const house = await generateHouseKeypair();
    const { pool, queries } = fakePool(restoredRow(house));
    const s = new HouseKeysService(pool, noopLog, {});

    // Boot with no secret and no provisioning: refuses, never mints.
    await expect(s.ensure()).rejects.toBeInstanceOf(HouseKeyMissingError);
    await expect(s.ensure({ provision: false })).rejects.toBeInstanceOf(HouseKeyMissingError);
    expect(insertedHouseKeys(queries)).toHaveLength(0);

    // And the refusal is actionable rather than cryptic.
    const err = await s.ensure().catch((e: Error) => e);
    expect(String(err)).toContain(HOUSE_AGE_IDENTITY_ENV);
    expect(String(err)).toContain(HOUSE_ED25519_PRIVATE_ENV);
    expect(String(err)).toContain("docs/RUNBOOK-house-key.md");
  });

  it("names the export remedy when the private halves are still in the database", async () => {
    const house = await generateHouseKeypair();
    const { pool } = fakePool({
      age_recipient: house.ageRecipient,
      ed25519_public: house.ed25519Public,
      age_identity: house.ageIdentity,
      ed25519_private: house.ed25519Private,
    });
    const s = new HouseKeysService(pool, noopLog, {});

    const err = await s.get().catch((e: Error) => e);
    expect(err).toBeInstanceOf(HouseKeyMissingError);
    expect(String(err)).toContain("npm run house:key:init");
  });

  it("never puts a private half in a refusal message", async () => {
    const house = await generateHouseKeypair();
    const { pool } = fakePool(restoredRow(house));
    const s = new HouseKeysService(pool, noopLog, {});

    const err = await s.get().catch((e: Error) => e);
    const text = String(err) + JSON.stringify((err as Error).message);
    expect(text).not.toContain(house.ageIdentity);
    expect(text).not.toContain(house.ed25519Private);
  });
});

describe("HouseKeysService — the secret must belong to the row", () => {
  it("accepts the matching secret and mirrors the public halves", async () => {
    const house = await generateHouseKeypair();
    const { pool } = fakePool(restoredRow(house));
    const s = new HouseKeysService(pool, noopLog, envOf(house));

    const key = await s.get();
    expect(key).not.toBeNull();
    expect(key!.ageIdentity).toBe(house.ageIdentity);
    expect(await s.ensure()).toMatchObject({ ageRecipient: house.ageRecipient });
  });

  it("refuses a secret from another house — the two are a pair or nothing", async () => {
    const thisHouse = await generateHouseKeypair();
    const anotherHouse = await generateHouseKeypair();
    const { pool } = fakePool(restoredRow(thisHouse));
    const s = new HouseKeysService(pool, noopLog, envOf(anotherHouse));

    // A restored database plus the wrong .env.enc must not half-work: sealing
    // to one recipient and unsealing with another identity is worse than
    // refusing, because it fails per-letter much later.
    await expect(s.get()).rejects.toBeInstanceOf(HouseKeyMismatchError);
    await expect(s.unsealBody("-----BEGIN AGE ENCRYPTED FILE-----")).rejects.toBeInstanceOf(
      HouseKeyMismatchError,
    );
  });

  it("refuses a malformed secret rather than echoing it", async () => {
    const house = await generateHouseKeypair();
    const { pool } = fakePool(restoredRow(house));
    const s = new HouseKeysService(pool, noopLog, {
      [HOUSE_AGE_IDENTITY_ENV]: "not-an-age-identity",
      [HOUSE_ED25519_PRIVATE_ENV]: "not-a-private-key",
    });

    const err = await s.get().catch((e: Error) => e);
    expect(err).toBeInstanceOf(HouseKeyMismatchError);
    expect((err as Error).message).not.toContain("not-an-age-identity");
    expect((err as Error).message).not.toContain("not-a-private-key");
  });
});

describe("HouseKeysService — provisioning writes public halves only", () => {
  it("inserts no private column and hands the private halves back to the caller", async () => {
    const { pool, queries, current } = fakePool();
    const s = new HouseKeysService(pool, noopLog, {});

    const key = await s.provision();

    const [insert] = insertedHouseKeys(queries);
    expect(insert.sql).not.toContain("age_identity");
    expect(insert.sql).not.toContain("ed25519_private");
    expect(insert.params).toEqual([key.ageRecipient, key.ed25519Public]);

    // The row it left behind carries the public halves and no private ones.
    const row = current();
    expect(row?.age_identity).toBeNull();
    expect(row?.ed25519_private).toBeNull();

    // …while the caller has the private halves, which is what init writes to
    // the secret store.
    expect(key.ageIdentity.startsWith("AGE-SECRET-KEY-1")).toBe(true);
    expect(ed25519PublicOf(key.ed25519Private)).toBe(key.ed25519Public);
  });

  it("is idempotent — an existing row is mirrored, never replaced", async () => {
    const house = await generateHouseKeypair();
    const { pool, queries } = fakePool(restoredRow(house));
    const s = new HouseKeysService(pool, noopLog, envOf(house));

    const first = await s.ensure({ provision: true });
    const second = await s.ensure({ provision: true });
    expect(second.ageRecipient).toBe(first.ageRecipient);
    expect(insertedHouseKeys(queries)).toHaveLength(0);
  });

  it("refuses to provision over a row whose private half is not in hand", async () => {
    const house = await generateHouseKeypair();
    const { pool, queries } = fakePool(restoredRow(house));
    const s = new HouseKeysService(pool, noopLog, {});

    // The row exists and nobody holds the private half: minting a replacement
    // here is exactly the identity change this service exists to prevent.
    await expect(s.provision()).rejects.toBeInstanceOf(HouseKeyMissingError);
    expect(insertedHouseKeys(queries)).toHaveLength(0);
  });

  it("mirrors the public halves into the address book for house@house", async () => {
    const { pool, queries } = fakePool();
    const s = new HouseKeysService(pool, noopLog, {});
    await s.provision();

    const addressInsert = queries.find((q) => q.sql.includes("INSERT INTO addresses"));
    expect(addressInsert).toBeDefined();
    expect(addressInsert!.params).toContain(HOUSE_ADDRESS);
    expect(queries.some((q) => q.sql.includes("INSERT INTO address_keys"))).toBe(true);
  });
});

describe("HouseKeysService — the serving path never touches a private column", () => {
  it("selects only the public halves and reads the rest from the environment", async () => {
    const house = await generateHouseKeypair();
    const { pool, queries } = fakePool(restoredRow(house));
    const s = new HouseKeysService(pool, noopLog, envOf(house));

    await s.get();
    await s.ensure();
    await s.publicHalves();

    // `legacyPrivateHalves()` is the one method allowed to name them, and it
    // is not on this path.
    const selectStatements = queries.filter((q) => q.sql.includes("SELECT"));
    expect(selectStatements.length).toBeGreaterThan(0);
    for (const q of selectStatements) {
      expect(q.sql).not.toContain("age_identity");
      expect(q.sql).not.toContain("ed25519_private");
    }
  });
});

describe("HouseKeysService — a restored database without the secret", () => {
  it("cannot open a collaborative letter, while a sealed letter still opens with the resident's own key", async () => {
    const house = await generateHouseKeypair();
    const resident = await generateResidentKeypair("you@house");

    // Two letters, both stored. The collaborative one is sealed to the
    // resident AND to house@house; the sealed one to the resident alone.
    const collaborativeText = "the house is party to this";
    const sealedText = "not even the house";
    const collaborative = await sealToRecipients(collaborativeText, [
      resident.public.ageRecipient,
      house.ageRecipient,
    ]);
    const sealed = await sealToRecipients(sealedText, [resident.public.ageRecipient]);

    // The restore: the database comes back — public halves, letters, all —
    // and the secret store does not. This is a dump in someone else's hands.
    const { pool } = fakePool(restoredRow(house));
    const s = new HouseKeysService(pool, noopLog, {});

    // (a) The house cannot open the collaborative letter. Not "silently
    // degraded": the failure is named, so an operator learns the archive has
    // lost its collaborative layer instead of seeing empty strings forever.
    await expect(s.unsealBody(collaborative)).rejects.toBeInstanceOf(HouseKeyMissingError);
    // The ciphertext is still there and still undecryptable by the house.
    expect(await unsealWithIdentity(collaborative, "")).toBeNull();

    // (c) The sealed letter is unaffected: it never depended on the house key,
    // so in that same state the resident opens it with their own identity.
    expect(await unsealWithIdentity(sealed, resident.ageIdentity)).toBe(sealedText);

    // The contrast that makes it a test rather than an accident: put the
    // secret back and the same database opens the same collaborative letter.
    const restored = new HouseKeysService(pool, noopLog, envOf(house));
    expect(await restored.unsealBody(collaborative)).toBe(collaborativeText);
    expect(await restored.unsealBody(sealed)).toBeNull(); // still not the house's to read
  });
});

describe("HouseKeysService — unseal", () => {
  it("unseals collaborative letters only — a private seal stays closed", async () => {
    const house = await generateHouseKeypair();
    const { pool } = fakePool(restoredRow(house));
    const s = new HouseKeysService(pool, noopLog, envOf(house));

    const resident = await generateResidentKeypair("you@house");
    const collaborative = await sealToRecipients("the house can read this", [
      resident.public.ageRecipient,
      house.ageRecipient,
    ]);
    expect(await s.unsealBody(collaborative)).toBe("the house can read this");

    const privateSeal = await sealToRecipients("only the recipient", [
      resident.public.ageRecipient,
    ]);
    expect(await s.unsealBody(privateSeal)).toBeNull();
  });

  it("a key minted in this process can unseal without the environment", async () => {
    // The test/CLI path: provision() keeps the private halves in memory because
    // the table no longer receives them.
    const { pool } = fakePool();
    const s = new HouseKeysService(pool, noopLog, {});
    const house = await s.provision();
    const resident = await generateResidentKeypair("you@house");
    const collaborative = await sealToRecipients("collaborative", [
      resident.public.ageRecipient,
      house.ageRecipient,
    ]);
    expect(await s.unsealBody(collaborative)).toBe("collaborative");
  });
});
