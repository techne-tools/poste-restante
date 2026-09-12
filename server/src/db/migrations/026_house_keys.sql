-- 026_house_keys.sql
-- The house's own keypair — a participant key, never a master key (SPEC §15).
--
-- The second model made literal: clients hold resident keys; the house
-- holds exactly ONE keypair — its own. Collaborative letters encrypt to
-- the recipient + house@house; the house decrypts in memory on read,
-- never stores plaintext. Sealed letters encrypt to the recipients only
-- — the house cannot open them even compromised.
--
-- House invariants enforced here:
--   * A singleton, not a table of keys. The house has exactly one
--     keypair; there is no key ring, no rotation history, no admin
--     class of keys. `id = 1 CHECK` makes the singleton structural.
--   * The private halves live here — the one private key the house
--     legitimately holds. This is a small, auditable surface: a raw DB
--     dump exposes the house's *collaborative* layer, never the sealed
--     layer (the threat model says exactly that).
--   * Public halves are mirrored into address_keys for house@house via
--     the service (public keys are public; correspondents discover the
--     house's recipient through the address book like any resident's).
--
-- The house key rotates rarely and re-encrypts collaborative letters via
-- a migration letter (a later slice); v1 provisions once.

CREATE TABLE IF NOT EXISTS house_keys (
    id                integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    age_identity      text NOT NULL,
    age_recipient     text NOT NULL,
    ed25519_private   text NOT NULL,
    ed25519_public    text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
