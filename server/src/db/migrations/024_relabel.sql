-- 024_relabel.sql
-- The relabel mechanism (SPEC §19) — the handle is a label, the identity
-- is the key.
--
-- A resident may change their handle at will; the identity, the edges,
-- the letter ids, the trust — all unchanged. The letter id hashes the
-- identity (migration 022), the OIDC binding keys off the identity
-- (migration 023), so a relabel is a single UPDATE on addresses.id that
-- cascades through every edge.
--
-- House invariants enforced here:
--   * The old handle is retired — never reused, never claimable (a
--     deadname must not become someone else's name).
--   * The identity never changes on relabel: identity_id stays, the
--     letter ids stay, the OIDC binding stays.
--   * The act IS a letter: the rename letter is the archive's record of
--     the change; the mechanism is the change.
--   * Every FK that references addresses(id) gains ON UPDATE CASCADE so
--     the relabel propagates structurally — no hand-written edge updates,
--     no drift. The oidc_bindings FK references identity_id (unchanged),
--     so it needs no cascade.

-- The retired handle registry — a deadname must not become someone
-- else's name.
CREATE TABLE IF NOT EXISTS retired_handles (
    handle      text PRIMARY KEY,
    retired_at  timestamptz NOT NULL DEFAULT now()
);

-- ── ON UPDATE CASCADE on every FK referencing addresses(id) ──────────────

ALTER TABLE address_keys DROP CONSTRAINT address_keys_address_fkey;
ALTER TABLE address_keys ADD CONSTRAINT address_keys_address_fkey
    FOREIGN KEY (address) REFERENCES addresses(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE agents DROP CONSTRAINT agents_creator_fkey;
ALTER TABLE agents ADD CONSTRAINT agents_creator_fkey
    FOREIGN KEY (creator) REFERENCES addresses(id) ON UPDATE CASCADE;

ALTER TABLE agents DROP CONSTRAINT agents_address_fkey;
ALTER TABLE agents ADD CONSTRAINT agents_address_fkey
    FOREIGN KEY (address) REFERENCES addresses(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE agents DROP CONSTRAINT agents_beneficiary_fkey;
ALTER TABLE agents ADD CONSTRAINT agents_beneficiary_fkey
    FOREIGN KEY (beneficiary) REFERENCES addresses(id) ON UPDATE CASCADE;

ALTER TABLE clause_objectors DROP CONSTRAINT clause_objectors_address_fkey;
ALTER TABLE clause_objectors ADD CONSTRAINT clause_objectors_address_fkey
    FOREIGN KEY (address) REFERENCES addresses(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE clause_vouchers DROP CONSTRAINT clause_vouchers_address_fkey;
ALTER TABLE clause_vouchers ADD CONSTRAINT clause_vouchers_address_fkey
    FOREIGN KEY (address) REFERENCES addresses(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE clauses DROP CONSTRAINT clauses_proposed_by_fkey;
ALTER TABLE clauses ADD CONSTRAINT clauses_proposed_by_fkey
    FOREIGN KEY (proposed_by) REFERENCES addresses(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE credentials DROP CONSTRAINT credentials_address_fkey;
ALTER TABLE credentials ADD CONSTRAINT credentials_address_fkey
    FOREIGN KEY (address) REFERENCES addresses(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE invites DROP CONSTRAINT invites_redeemed_by_fkey;
ALTER TABLE invites ADD CONSTRAINT invites_redeemed_by_fkey
    FOREIGN KEY (redeemed_by) REFERENCES addresses(id) ON UPDATE CASCADE ON DELETE SET NULL;

ALTER TABLE invites DROP CONSTRAINT invites_created_by_fkey;
ALTER TABLE invites ADD CONSTRAINT invites_created_by_fkey
    FOREIGN KEY (created_by) REFERENCES addresses(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE letter_addresses DROP CONSTRAINT letter_addresses_address_id_fkey;
ALTER TABLE letter_addresses ADD CONSTRAINT letter_addresses_address_id_fkey
    FOREIGN KEY (address_id) REFERENCES addresses(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE letter_reads DROP CONSTRAINT letter_reads_address_id_fkey;
ALTER TABLE letter_reads ADD CONSTRAINT letter_reads_address_id_fkey
    FOREIGN KEY (address_id) REFERENCES addresses(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE thread_participation DROP CONSTRAINT thread_participation_address_id_fkey;
ALTER TABLE thread_participation ADD CONSTRAINT thread_participation_address_id_fkey
    FOREIGN KEY (address_id) REFERENCES addresses(id) ON UPDATE CASCADE ON DELETE CASCADE;

ALTER TABLE whispers DROP CONSTRAINT whispers_target_address_fkey;
ALTER TABLE whispers ADD CONSTRAINT whispers_target_address_fkey
    FOREIGN KEY (target_address) REFERENCES addresses(id) ON UPDATE CASCADE ON DELETE CASCADE;

-- The `rename` letter kind joins the protocol (first-class because a
-- relabel is a distinct act — the will — not a private letter, not a
-- system letter from the house).
ALTER TABLE letters DROP CONSTRAINT letters_kind_check;
ALTER TABLE letters ADD CONSTRAINT letters_kind_check
    CHECK (kind IN ('letter','feed','system','audio','note','task','invite','clause','leave','join','agent','rename'));
