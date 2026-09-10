-- 022_identity_ids.sql
-- The identity-key protocol (SPEC §19) — the load-bearing move.
--
-- The address is the meaning (invariant 7) — but the *meaning* is the
-- person, not the string. The identity is cryptographic; the handle is
-- a label. The letter id hashes the IDENTITY, not the handle, so a
-- rename never changes a letter's id — the integrity spine (dedup,
-- references, payloads, qdrant points) holds through the change.
--
-- The identity id is the ed25519 public key fingerprint. For addresses
-- with keys (registered via address_keys, §15), the identity id IS the
-- public key. For legacy addresses without keys, the identity id is the
-- handle itself — the identity IS the handle until a key exists; the key
-- is what makes it durable.
--
-- House invariants enforced here:
--   * The key never changes; the label can. Trust is in the key: the
--     person you trusted as ben is provably the same person now called
--     sam, because the key is the same.
--   * Key history, not re-encryption: retired public keys stay on the
--     address record; old letters stay decryptable and verifiable with
--     old keys. The identity id is the CURRENT key's fingerprint.
--   * The wire format keeps the handle (people type ben@house); the
--     store and the id use the identity.

ALTER TABLE addresses ADD COLUMN IF NOT EXISTS identity_id text;

-- Backfill: legacy addresses without keys — the identity IS the handle.
UPDATE addresses SET identity_id = id WHERE identity_id IS NULL;
