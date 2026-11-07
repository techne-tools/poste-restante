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
--   * PUBLIC HALVES ONLY — corrected 2026-11-08 (PLAN-crypto.md C2). This
--     row carries `age_recipient` and `ed25519_public`. Public keys are
--     public: a correspondent needs the house's recipient to seal to it,
--     and `address_keys` mirrors the same two values for house@house so
--     the address book stays the one place a recipient is discovered.
--     The PRIVATE halves do not live here. They are read at boot from
--     the deployment's secret store (HOUSE_AGE_IDENTITY /
--     HOUSE_ED25519_PRIVATE, `.env.enc` under sops+age), so a raw
--     database dump plus every letter still cannot open a collaborative
--     letter. The original header said the opposite — "the private
--     halves live here — the one private key the house legitimately
--     holds" — which was true of the code and was exactly the leak:
--     a dump held the ciphertext and the key. `age_identity` and
--     `ed25519_private` survive as deprecated nullable columns only so a
--     house that has not been upgraded yet keeps its one copy; migration
--     032 relaxes them, `npm run house:key:init` exports them, and
--     `npm run house:key:forget-db-halves` empties them. Procedure:
--     docs/RUNBOOK-house-key.md.
--   * Sealed letters are untouched by any of this. No house key of any
--     kind opens one, so a dump could not read them before the correction
--     and cannot now.
--
-- DECIDED 2026-11-08 — NO HOUSE-KEY ROTATION IN V1 (Chris). The singleton is
-- provisioned once, `npm run house:key:init`, and backed up off-box
-- (docs/RUNBOOK-house-key.md). Rotation is a future plan with its own
-- migration story; nothing in v1 re-keys the house or rewrites a body.
-- "Re-encrypts collaborative letters" was never implementable and is
-- withdrawn: the letter id is sha256 over the canonical form including body
-- content, the ed25519 signature is over that id, and the house never holds
-- a resident's signing key — re-encryption would change every id, orphan
-- letter_addresses / letter_frames / the payload catalog / Qdrant points,
-- and could not re-sign. 018 already set the rule for residents: key
-- history, not re-encryption.
--
-- Losing the key: collaborative letters sealed before the loss become
-- unreadable — no re-encryption can rescue them, because re-encryption is
-- the thing that cannot exist. Sealed letters are unaffected: no house key
-- of any kind ever opened one. Recovery is the off-box backup, not
-- re-minting — a new key is a new identity and opens nothing old.
--
-- So the "no rotation history" invariant above stands unchanged: there is no
-- rotation, therefore no history to keep. One active key, and no admin class
-- of keys.

CREATE TABLE IF NOT EXISTS house_keys (
    id                integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    age_identity      text NOT NULL,
    age_recipient     text NOT NULL,
    ed25519_private   text NOT NULL,
    ed25519_public    text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
