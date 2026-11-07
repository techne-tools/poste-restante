/**
 * HouseKeysService — the house's own keypair (SPEC §15, second model).
 *
 * Clients hold resident keys; the house holds exactly ONE keypair — its
 * own, a participant key, never a master key. Collaborative letters
 * encrypt to the recipient + house@house; the house decrypts in memory
 * on read, never stores plaintext. Sealed letters encrypt to the
 * recipients only — the house cannot open them even compromised.
 *
 * CUSTODY (PLAN-crypto.md C2, 2026-11-08). The keypair is split by
 * publicity, not by convenience:
 *
 *   * The PUBLIC halves (`age_recipient`, `ed25519_public`) live in the
 *     `house_keys` singleton and are mirrored into `address_keys` for
 *     house@house. Public keys are public — a correspondent needs them to
 *     seal, and the address book is where any resident's recipient is
 *     discovered.
 *   * The PRIVATE halves never enter the database. They are read at boot
 *     from the deployment's secret store — `HOUSE_AGE_IDENTITY` and
 *     `HOUSE_ED25519_PRIVATE`, which `deploy.sh` merges out of `.env.enc`
 *     (sops + age) — and are the one thing a database dump does not hold.
 *     A dump therefore opens unsealed letters and nothing else:
 *     collaborative letters need the secret store as well, and a sealed
 *     letter needs a recipient's own key.
 *
 * Refusal, not repair. If the row is missing, if the secret is missing, or
 * if the two disagree, the service raises a named error that names the
 * remedy. It never mints on boot: a restored database without its key
 * would otherwise acquire a new identity and strand every collaborative
 * letter sealed to the old one — an unrecoverable loss that looks exactly
 * like a successful start. Provisioning is the explicit operator act
 * `npm run house:key:init`; the offline procedure is
 * `docs/RUNBOOK-house-key.md`.
 *
 * Nothing in this file logs, throws, or returns a private half by accident:
 * the only place a private half crosses this boundary is the explicit
 * `legacyPrivateHalves()` / `provision()` return values, which exist for the
 * operator CLI to write into the secret store.
 */
import type pg from "pg";
import type { Logger } from "../pipeline/logger.js";
import {
  ageRecipientOf,
  ed25519PublicOf,
  generateHouseKeypair,
  unsealWithIdentity,
  type HouseKeypair,
} from "../crypto/keys.js";

/** The house's own address — a participant in collaborative letters. */
export const HOUSE_ADDRESS = "house@house";

/** The environment variable carrying the house's age identity (private). */
export const HOUSE_AGE_IDENTITY_ENV = "HOUSE_AGE_IDENTITY";
/** The environment variable carrying the house's ed25519 private key. */
export const HOUSE_ED25519_PRIVATE_ENV = "HOUSE_ED25519_PRIVATE";
/** The procedure an operator is sent to when a key check fails. */
export const HOUSE_KEY_RUNBOOK = "docs/RUNBOOK-house-key.md";

/** The public half of the house's keypair — all a correspondent needs. */
export interface HousePublicHalves {
  ageRecipient: string;
  ed25519Public: string;
}

/**
 * Thrown when the house cannot assemble its keypair — the row is absent, the
 * secret store is empty, or the private halves are still sitting in the
 * database waiting to be exported.
 *
 * Each variant names the remedy. None of them contains key material.
 */
export class HouseKeyMissingError extends Error {
  constructor(reason: "unprovisioned" | "secret-absent" | "legacy-in-database" = "unprovisioned") {
    const message =
      reason === "unprovisioned"
        ? "the house has no keypair. Provision one with `npm run house:key:init` " +
          "(in server/) and put the private halves in the secret store. Refusing " +
          "to mint on boot: a restored database would otherwise change identity " +
          `and strand every collaborative letter. See ${HOUSE_KEY_RUNBOOK}.`
        : reason === "legacy-in-database"
          ? "the house's private halves are still in the database and the secret " +
            "store is empty. Move them out with `npm run house:key:init` (it writes " +
            `containers/poste-restante/.env.house-key), then follow ${HOUSE_KEY_RUNBOOK}.`
          : `the house's private halves are not in the environment (${HOUSE_AGE_IDENTITY_ENV}, ` +
            `${HOUSE_ED25519_PRIVATE_ENV}). Restore them from the secret store (.env.enc) — ` +
            `see ${HOUSE_KEY_RUNBOOK}. If they are lost, collaborative letters from before ` +
            "the loss are unreadable forever; sealed letters are unaffected.";
    super(message);
    this.name = "HouseKeyMissingError";
  }
}

/**
 * Thrown when the secret in the environment does not derive the public halves
 * stored in `house_keys`. That pair is not a house: acting on it would either
 * mirror a recipient nobody can seal to, or try to unseal with an identity
 * nobody sealed to. Fail closed.
 */
export class HouseKeyMismatchError extends Error {
  constructor() {
    super(
      `the house's secret does not belong to this database: ${HOUSE_AGE_IDENTITY_ENV} / ` +
        `${HOUSE_ED25519_PRIVATE_ENV} do not derive the public halves in house_keys. ` +
        "The secret store and the database are from different houses — restore the " +
        ".env.enc that matches this database, or the database that matches the secret. " +
        `See ${HOUSE_KEY_RUNBOOK}.`,
    );
    this.name = "HouseKeyMismatchError";
  }
}

export class HouseKeysService {
  /**
   * A keypair this process provisioned itself — the test path and the operator
   * CLI. Never read from the database; it exists because `provision()` hands
   * the private halves to its caller (the secret store) and not to the table,
   * so an in-process house that just minted has nowhere else to keep them.
   */
  private provisioned: HouseKeypair | null = null;

  /** The last keypair whose secret was verified against the row. */
  private verified: HouseKeypair | null = null;
  private verifiedFor: string | null = null;

  constructor(
    private readonly pool: pg.Pool,
    private readonly log: Logger,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {}

  /**
   * The public halves from the table. Needs no secret, so it is safe for any
   * route that tells a correspondent what to seal to. Null when the house has
   * not been provisioned yet.
   */
  async publicHalves(): Promise<HousePublicHalves | null> {
    const { rows } = await this.pool.query<{
      age_recipient: string;
      ed25519_public: string;
    }>(`SELECT age_recipient, ed25519_public FROM house_keys WHERE id = 1`);
    const row = rows[0];
    if (!row) return null;
    return { ageRecipient: row.age_recipient, ed25519Public: row.ed25519_public };
  }

  /**
   * The house's full keypair — public halves from the table, private halves
   * from the secret store. Null only when the house has no keypair at all;
   * a house that has a row but no usable secret raises rather than returning
   * a degraded key (see `HouseKeyMissingError`, `HouseKeyMismatchError`).
   */
  async get(): Promise<HouseKeypair | null> {
    const pub = await this.publicHalves();
    if (!pub) return null;

    // Verified once per process: the secret comes from the environment, which
    // does not change under a running process.
    if (this.verified && this.verifiedFor === pub.ageRecipient) return this.verified;

    const ageIdentity = this.env[HOUSE_AGE_IDENTITY_ENV];
    const ed25519Private = this.env[HOUSE_ED25519_PRIVATE_ENV];

    if (!ageIdentity || !ed25519Private) {
      // The one legitimate non-environment source: this process minted it.
      if (this.provisioned && this.provisioned.ageRecipient === pub.ageRecipient) {
        return this.provisioned;
      }
      const legacy = await this.legacyPrivateHalves();
      this.log.error("house:key-secret-missing", {
        required: [HOUSE_AGE_IDENTITY_ENV, HOUSE_ED25519_PRIVATE_ENV],
        remedy: legacy
          ? "npm run house:key:init — export the private halves still in the database"
          : `restore .env.enc — see ${HOUSE_KEY_RUNBOOK}`,
      });
      throw new HouseKeyMissingError(legacy ? "legacy-in-database" : "secret-absent");
    }

    // The secret must derive the stored public halves. Anything else means the
    // secret store and the database belong to different houses.
    let recipient: string;
    let edPublic: string;
    try {
      recipient = await ageRecipientOf(ageIdentity);
      edPublic = ed25519PublicOf(ed25519Private);
    } catch {
      // A malformed secret is a mismatch, not a diagnostic opportunity — and
      // the caught error may quote the value, so it is never surfaced.
      this.log.error("house:key-secret-malformed", {
        remedy: `restore .env.enc — see ${HOUSE_KEY_RUNBOOK}`,
      });
      throw new HouseKeyMismatchError();
    }
    if (recipient !== pub.ageRecipient || edPublic !== pub.ed25519Public) {
      this.log.error("house:key-secret-mismatch", {
        remedy: `the secret store and the database disagree — see ${HOUSE_KEY_RUNBOOK}`,
      });
      throw new HouseKeyMismatchError();
    }

    const key: HouseKeypair = {
      ageIdentity,
      ed25519Private,
      ageRecipient: pub.ageRecipient,
      ed25519Public: pub.ed25519Public,
    };
    this.verified = key;
    this.verifiedFor = pub.ageRecipient;
    return key;
  }

  /**
   * Read the house's keypair and mirror its public halves to the address book
   * (house@house is a participant in collaborative letters; its recipient is
   * discovered like any resident's). Refuses rather than mints — see
   * `HouseKeyMissingError`. `provision: true` exists for the explicit operator
   * path and for tests; nothing in the serving path passes it.
   */
  async ensure(opts: { provision?: boolean } = {}): Promise<HouseKeypair> {
    const pub = await this.publicHalves();
    if (pub) {
      // Mirror the public halves in case the address rows were wiped
      // (tests TRUNCATE; a fresh house after a restore must still be
      // reachable). Cheap and idempotent.
      const existing = await this.get();
      // get() returns null only when the row is absent, which `pub` rules out.
      if (!existing) throw new HouseKeyMissingError("unprovisioned");
      await this.mirrorPublic(existing);
      return existing;
    }

    if (!opts.provision) {
      this.log.error("house:key-missing", {
        remedy: "npm run house:key:init",
      });
      throw new HouseKeyMissingError();
    }

    return this.provision();
  }

  /**
   * Provision the singleton — the explicit operator act (`npm run
   * house:key:init`) and the test path.
   *
   * Writes the PUBLIC halves to the table and returns the whole keypair,
   * private halves included, for the caller to place in the secret store: the
   * table never receives them. Idempotent — an existing row is mirrored and
   * returned, never replaced; when a row exists the private halves must come
   * from `key` or from this process's own mint, because the database no longer
   * knows them.
   */
  async provision(key?: HouseKeypair): Promise<HouseKeypair> {
    const existing = await this.publicHalves();
    if (existing) {
      const full = key ?? this.provisioned;
      if (!full || full.ageRecipient !== existing.ageRecipient) {
        // The row exists but the private half is not in hand. Minting a
        // replacement here is exactly the identity change this service
        // refuses; the operator must restore the secret.
        throw new HouseKeyMissingError("secret-absent");
      }
      this.provisioned = full;
      await this.mirrorPublic(full);
      return full;
    }

    const fresh = key ?? (await generateHouseKeypair());
    await this.pool.query(
      `INSERT INTO house_keys (id, age_recipient, ed25519_public)
       VALUES (1, $1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [fresh.ageRecipient, fresh.ed25519Public],
    );

    // Concurrent-first-wins: if another boot raced us, the INSERT that lost
    // returns nothing — read the winner back. Its identity is not ours, so the
    // private halves in hand belong to nobody and this is a refusal, not a
    // silent preference for one of the two.
    const stored = await this.publicHalves();
    if (stored && stored.ageRecipient !== fresh.ageRecipient) {
      throw new HouseKeyMismatchError();
    }

    this.provisioned = fresh;
    await this.mirrorPublic(fresh);
    this.log.info("house:key-ensured", {
      ageRecipient: fresh.ageRecipient.slice(-8),
      ed25519Public: fresh.ed25519Public.slice(-8),
    });
    return fresh;
  }

  /**
   * The private halves as they sit in the deprecated `house_keys` columns —
   * the upgrade path only. Returns null on a house that never stored them (or
   * that has already been emptied). Never used to serve a request: the whole
   * point is that the serving path does not read private columns.
   */
  async legacyPrivateHalves(): Promise<HouseKeypair | null> {
    const { rows } = await this.pool.query<{
      age_identity: string | null;
      age_recipient: string;
      ed25519_private: string | null;
      ed25519_public: string;
    }>(
      `SELECT age_identity, age_recipient, ed25519_private, ed25519_public
       FROM house_keys WHERE id = 1`,
    );
    const row = rows[0];
    if (!row?.age_identity || !row.ed25519_private) return null;
    return {
      ageIdentity: row.age_identity,
      ed25519Private: row.ed25519_private,
      ageRecipient: row.age_recipient,
      ed25519Public: row.ed25519_public,
    };
  }

  /**
   * Remove the private halves from the table — the last step of the move, and
   * the one that makes "the private halves are not in the database" true of
   * this house rather than merely of its code.
   *
   * Refuses unless `get()` succeeds, which is the proof that the secret store
   * already holds the matching halves: this deletes what may be the only copy.
   */
  async forgetDbHalves(): Promise<boolean> {
    const key = await this.get(); // throws unless the secret is present and matches
    if (!key) throw new HouseKeyMissingError("unprovisioned");
    await this.pool.query(
      `UPDATE house_keys
          SET age_identity = NULL, ed25519_private = NULL, updated_at = now()
        WHERE id = 1`,
    );
    return true;
  }

  private async mirrorPublic(key: HouseKeypair): Promise<void> {
    // house@house exists in the social graph (a participant — the
    // address book shows it flat, and its key record carries the
    // house's public halves).
    await this.pool.query(
      `INSERT INTO addresses (id, identity_id) VALUES ($1, $1)
       ON CONFLICT (id) DO NOTHING`,
      [HOUSE_ADDRESS],
    );
    // Key history (030): the mirror never OVERWRITES a public half. If the
    // singleton disagrees with the live record, the live record is CLOSED and
    // the singleton appended — so the old public half survives, and
    // collaborative letters sealed to it stay openable. `ON CONFLICT (address)
    // WHERE retired_at IS NULL` names the partial unique index, so the mirror
    // is idempotent and never mints a generation for an unchanged key.
    await this.pool.query(
      `UPDATE address_keys SET retired_at = now()
        WHERE address = $1 AND retired_at IS NULL
          AND (age_recipient <> $2 OR ed25519_public <> $3)`,
      [HOUSE_ADDRESS, key.ageRecipient, key.ed25519Public],
    );
    await this.pool.query(
      `INSERT INTO address_keys (address, age_recipient, ed25519_public, recovery_age_recipient)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (address) WHERE retired_at IS NULL DO NOTHING`,
      [HOUSE_ADDRESS, key.ageRecipient, key.ed25519Public],
    );
  }

  /**
   * Unseal a collaborative letter's body with the house's own age identity —
   * "the house decrypts in memory on read, never stores plaintext" (SPEC §15).
   *
   * Returns null when the ciphertext is not addressed to the house (a
   * sealed-only letter), and raises when the house has no usable key: "not for
   * us" and "we lost our key" are different facts and must not look alike.
   * v1 proves the capability; its consumer (the whisper and gap engine reading
   * collaborative bodies) is the recorded follow-on.
   */
  async unsealBody(ciphertext: string): Promise<string | null> {
    const key = await this.get();
    if (!key) throw new HouseKeyMissingError("unprovisioned");
    return unsealWithIdentity(ciphertext, key.ageIdentity);
  }
}
