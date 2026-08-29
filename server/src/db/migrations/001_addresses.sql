-- 001_addresses.sql
-- The address book is the social graph.
--
-- House invariants enforced here:
--   * Anti-hierarchy: no owner field, no admin class, no ranking, no follower
--     counts. The address book is flat — just who you correspond with.
--   * Queer/global-majority empowerment: a person is a SET of names, not
--     first+last. No gender field. Pronouns are free text.
--   * Privacy as schema: only the fields a delivery needs.

CREATE TABLE IF NOT EXISTS addresses (
    id          text PRIMARY KEY,          -- the address, e.g. 'ben@house'
    names       text[] NOT NULL DEFAULT '{}', -- a set of names, not first+last
    pronouns    text,                      -- free text, nullable
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The address is the meaning. Addresses are unique by construction (PK).
