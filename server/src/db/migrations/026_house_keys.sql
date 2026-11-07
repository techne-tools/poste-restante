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
--     030 relaxes them, `npm run house:key:init` exports them, and
--     `npm run house:key:forget-db-halves` empties them. Procedure:
--     docs/RUNBOOK-house-key.md.
--   * Sealed letters are untouched by any of this. No house key of any
--     kind opens one, so a dump could not read them before the correction
--     and cannot now.
--
-- The house key rotates rarely and re-encrypts collaborative letters via
-- a migration letter (a later slice); v1 provisions once.
--
-- UNRESOLVED 2026-11-08 — the last paragraph and the "no rotation history"
-- invariant above cannot both hold, and the contradiction is left standing
-- here rather than quietly resolved: rotation with a singleton means the old
-- identity is gone and every collaborative letter sealed to it becomes
-- unreadable, while keeping the old identity is the rotation history this
-- table rejects. Body re-encryption is not implementable at all — the letter
-- id is sha256 over the canonical form including body content, the ed25519
-- signature is over that id, and the house never holds a resident's signing
-- key, so re-encryption changes every id, orphans letter_addresses /
-- letter_frames / the payload catalog / Qdrant points, and cannot re-sign.
-- The decision (no rotation in v1, or house key history) is pending and will
-- be stated here in one unambiguous sentence when it is made — PLAN-crypto.md
-- C4. No body re-encryption will be implemented.

CREATE TABLE IF NOT EXISTS house_keys (
    id                integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
    age_identity      text NOT NULL,
    age_recipient     text NOT NULL,
    ed25519_private   text NOT NULL,
    ed25519_public    text NOT NULL,
    created_at        timestamptz NOT NULL DEFAULT now(),
    updated_at        timestamptz NOT NULL DEFAULT now()
);
