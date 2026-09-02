-- 013_leaving.sql
-- Leaving as first-class — the structural stop (SPEC §5.8 related).
--
-- Consent-forward: no and yes are equally significant. Leaving is the
-- structural stop on a thread — the move that protects you from someone
-- protects them from you, symmetric by construction. Today a reply locks a
-- resident into a thread's visibility forever; deletion exists, leaving
-- does not.
--
-- Leave/join are letters. A resident writes a `kind: "leave"` letter to
-- the thread (addressed to the thread's current participants — the act is
-- the correspondence); a `kind: "join"` letter reverses it. The archive
-- keeps the history; "current" is derived.
--
-- This table is the rememberer's cache: it holds the current participation
-- state per (thread, address) so the house can answer "is this resident
-- party to this thread?" without re-deriving the whole thread on every
-- read. Wiping it and re-deriving from the leave/join letters yields the
-- same rows — the letters are the source of truth, the table is the cache.
--
-- House invariants enforced here:
--   * Privacy as schema: visibility derives from participation, and
--     participation is derived from the letters. A leaver's edges dissolve
--     — the house prunes itself, it never needs a cron to forget.
--   * Absence is silence: a leaver gets 404, never 403. The house never
--     confirms existence.
--   * Symmetric by construction: the same move, available to everyone,
--     protects everyone. You leave to stop seeing someone; they leave to
--     stop seeing you. The mechanism is identical in both directions.
--   * The book is exempt: clause threads are commons by right — you cannot
--     leave the household's knowing of itself. Leave/join on clause
--     threads is refused at the route.
--
-- The `leave` and `join` letter kinds join the protocol (first-class
-- because a leave is a distinct act — a capability the household holds —
-- not a private letter, not a system letter from the house).

CREATE TABLE IF NOT EXISTS thread_participation (
    -- The thread and the address. One row per (thread, address).
    thread_id      text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    address_id     text NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    -- The current state: 'in' (participating) or 'out' (left). Addresses
    -- with no leave/join letter are 'in' by default — the historical edges
    -- stand; only a leave flips the state.
    state          text NOT NULL CHECK (state IN ('in','out')),
    -- The letter that set the current state (the latest leave/join).
    since_letter_id text NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
    -- The received_at of that letter. The upsert guard uses it to refuse
    -- out-of-order writes — a stale leave cannot overwrite a newer join.
    since_received_at timestamptz NOT NULL,
    PRIMARY KEY (thread_id, address_id)
);

CREATE INDEX IF NOT EXISTS thread_participation_address_idx
    ON thread_participation (address_id);

-- The `leave` and `join` letter kinds (first-class because a leave is a
-- distinct act — a capability the household holds — not a private letter,
-- not a system letter from the house).
ALTER TABLE letters DROP CONSTRAINT letters_kind_check;
ALTER TABLE letters ADD CONSTRAINT letters_kind_check
    CHECK (kind IN ('letter','feed','system','audio','note','task','invite','clause','leave','join'));
