/**
 * HouseKeysService — the house's own keypair (SPEC §15, second model).
 *
 * Clients hold resident keys; the house holds exactly ONE keypair — its
 * own, a participant key, never a master key. Collaborative letters
 * encrypt to the recipient + house@house; the house decrypts in memory
 * on read, never stores plaintext. Sealed letters encrypt to the
 * recipients only — the house cannot open them even compromised.
 *
 * Provisioning: on boot the house ensures its singleton keypair (one per
 * house — the table's `id = 1 CHECK` is structural) and mirrors the
 * PUBLIC halves into address_keys for house@house, so correspondents
 * discover the house's age recipient through the address book exactly
 * like any resident's (public keys are public). The private halves live
 * only in the singleton — the one private key the house legitimately
 * holds; a raw DB dump exposes the house's *collaborative* layer, never
 * the sealed layer (the threat model states that plainly).
 */
import type pg from "pg";
import type { Logger } from "../pipeline/logger.js";
import { generateHouseKeypair, unsealWithIdentity, type HouseKeypair } from "../crypto/keys.js";

/** The house's own address — a participant in collaborative letters. */
export const HOUSE_ADDRESS = "house@house";

export class HouseKeysService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly log: Logger,
  ) {}

  /** The stored house keypair — the singleton. */
  async get(): Promise<HouseKeypair | null> {
    const { rows } = await this.pool.query<{
      age_identity: string;
      age_recipient: string;
      ed25519_private: string;
      ed25519_public: string;
    }>(
      `SELECT age_identity, age_recipient, ed25519_private, ed25519_public
       FROM house_keys WHERE id = 1`,
    );
    const row = rows[0];
    if (!row) return null;
    return {
      ageIdentity: row.age_identity,
      ed25519Private: row.ed25519_private,
      ageRecipient: row.age_recipient,
      ed25519Public: row.ed25519_public,
    };
  }

  /**
   * Ensure the house's keypair exists — provision once on boot, mirror
   * the public halves to the address book (house@house is a participant
   * in collaborative letters; its recipient is discovered like any
   * resident's). Idempotent: already-provisioned houses keep their key.
   */
  async ensure(): Promise<HouseKeypair> {
    const existing = await this.get();
    if (existing) {
      // Mirror the public halves in case the address rows were wiped
      // (tests TRUNCATE; a fresh house after a restore must still be
      // reachable). Cheap and idempotent.
      await this.mirrorPublic(existing);
      return existing;
    }

    const fresh = await generateHouseKeypair();
    await this.pool.query(
      `INSERT INTO house_keys (id, age_identity, age_recipient, ed25519_private, ed25519_public)
       VALUES (1, $1, $2, $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [
        fresh.ageIdentity,
        fresh.ageRecipient,
        fresh.ed25519Private,
        fresh.ed25519Public,
      ],
    );

    // The concurrent-first-wins idempotence: if another boot raced us,
    // the INSERT that lost returns nothing — read the winner back.
    const stored = await this.get();
    const key = stored ?? fresh;
    await this.mirrorPublic(key);
    this.log.info("house:key-ensured", {
      ageRecipient: key.ageRecipient.slice(-8),
      ed25519Public: key.ed25519Public.slice(-8),
    });
    return key;
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
    await this.pool.query(
      `INSERT INTO address_keys (address, age_recipient, ed25519_public, recovery_age_recipient)
       VALUES ($1, $2, $3, NULL)
       ON CONFLICT (address) DO UPDATE
         SET age_recipient = $2, ed25519_public = $3, recovery_age_recipient = NULL, retired_at = NULL`,
      [HOUSE_ADDRESS, key.ageRecipient, key.ed25519Public],
    );
  }

  /**
   * Unseal a collaborative letter's body with the house's own age
   * identity — "the house decrypts in memory on read, never stores
   * plaintext" (SPEC §15). Only letters sealed *with* the house (its
   * recipient is in the circle) open; a private (sealed-only) letter
   * returns null. v1 proves the capability; its consumer (the whisper
   * and gap engine reading collaborative bodies) is the recorded
   * follow-on.
   */
  async unsealBody(ciphertext: string): Promise<string | null> {
    const key = await this.get();
    if (!key) return null;
    return unsealWithIdentity(ciphertext, key.ageIdentity);
  }
}
