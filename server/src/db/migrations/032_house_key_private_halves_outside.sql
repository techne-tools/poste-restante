-- 032_house_key_private_halves_outside.sql
-- The house's private halves leave the database (PLAN-crypto.md C2, 2026-11-08).
--
-- NUMBERING: 030 is taken by `030_address_key_history.sql` (the append-only
-- `address_keys` change, branch wt/t_5a5ec9e2) and 031 is reserved for the
-- sealed-payloads work; this migration was first written as 030 before those
-- branches met, and is numbered 032 so the two can land without sharing a
-- number. The number carries no meaning to the runner beyond sort order.
--
-- BEFORE: `026_house_keys` kept `age_identity` and `ed25519_private` in the
-- singleton row — in the same Postgres as every letter. A raw dump therefore
-- opened every collaborative letter (one sealed to house@house by including it
-- as a recipient) as well as every unsealed one. Sealed letters were the only
-- ones a dump could not read.
--
-- AFTER: the table keeps the PUBLIC halves only — `age_recipient` and
-- `ed25519_public`. Public keys are public: a correspondent needs the house's
-- recipient to seal to it, and `address_keys` mirrors the same two values for
-- house@house so the address book stays the one place a recipient is
-- discovered. The private halves are read at boot from the deployment's
-- secret store (`containers/poste-restante/.env.enc`, sops + age, delivered as
-- HOUSE_AGE_IDENTITY / HOUSE_ED25519_PRIVATE) and never touch the database.
-- A dump now needs the secret store as well to open a collaborative letter.
-- Procedure: docs/RUNBOOK-house-key.md.
--
-- WHY THE COLUMNS ARE RELAXED AND NOT DROPPED: on a house that has not been
-- upgraded yet these two columns hold the only copy of the private halves in
-- existence. A migration must never be the thing that destroys it — that is
-- how an archive loses an identity. They are therefore made nullable, so a
-- newly provisioned house can insert its public halves without them, and are
-- emptied only by the explicit operator act `npm run house:key:forget-db-halves`,
-- which refuses unless the secret store already holds the matching halves.
-- Deprecated, never read on the serving path: `HouseKeysService.get()` selects
-- the public columns only.

ALTER TABLE house_keys ALTER COLUMN age_identity DROP NOT NULL;
ALTER TABLE house_keys ALTER COLUMN ed25519_private DROP NOT NULL;

COMMENT ON COLUMN house_keys.age_identity IS
  'DEPRECATED 2026-11-08 — the age identity lives in the deployment secret store (HOUSE_AGE_IDENTITY, sops+age). This column survives only so an un-upgraded house keeps its one copy; `npm run house:key:init` exports it, `npm run house:key:forget-db-halves` empties it. Never read on the serving path.';

COMMENT ON COLUMN house_keys.ed25519_private IS
  'DEPRECATED 2026-11-08 — the ed25519 private key lives in the deployment secret store (HOUSE_ED25519_PRIVATE, sops+age). Same upgrade path as age_identity: export, then forget. Never read on the serving path.';
