-- 018_sealed_letters.sql
-- The cryptographic horizon (SPEC §15) — sealed letters and address keys.
--
-- A sealed letter's body is ciphertext; the house stores it, never reads
-- it. The envelope keeps the pointers (thread, frames, addresses); the
-- subject moves into the body (the one envelope field that is pure
-- content). The house verifies the signature on ingest and at rest; it
-- never embeds, FTSes, or whispers sealed bodies.
--
-- House invariants enforced here:
--   * Privacy as schema: `sealed` is a column, not a runtime flag. The
--     pipeline's embedding/FTS/whisper paths branch on it structurally.
--   * The house never holds a private key: `address_keys` stores only the
--     PUBLIC halves (age recipient + ed25519 public). Private keys are
--     client-held, consistent with "the house never holds a password."
--   * Public keys are public: readable by anyone (verification needs
--     them; they are not secrets).
--   * Key history, not re-encryption: retired public keys stay on the
--     address record (the `retired_at` column); old letters stay
--     decryptable and verifiable with old keys.

ALTER TABLE letters ADD COLUMN IF NOT EXISTS sealed boolean NOT NULL DEFAULT false;
ALTER TABLE letters ADD COLUMN IF NOT EXISTS signature text;

-- The address key record — the public halves only.
CREATE TABLE IF NOT EXISTS address_keys (
    address             text PRIMARY KEY REFERENCES addresses(id) ON DELETE CASCADE,
    age_recipient       text NOT NULL,
    ed25519_public      text NOT NULL,
    recovery_age_recipient text,
    retired_at          timestamptz,
    created_at          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS address_keys_retired_idx ON address_keys (retired_at);
