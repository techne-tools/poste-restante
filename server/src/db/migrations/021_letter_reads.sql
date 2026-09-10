-- 021_letter_reads.sql
-- The living pass read-back (SPEC §5 #12, the POSTPONED slice).
--
-- The house records opened/replied on whispers, not letters. The honest
-- read-back needs a per-resident letter_reads table: the learning loop's
-- signals, recorded per (letter, resident), so the house can read what
-- the resident actually engaged with — through the reference client or
-- through IMAP flags (\\Seen ⇄ opened, \\Answered ⇄ replied, \\Flagged ⇄
-- pinned).
--
-- House invariants enforced here:
--   * Privacy as schema: a row is per (letter, resident) — the house
--     records only what the resident themselves did. No global read
--     state, no "everyone saw this" column.
--   * The learning loop is the collaboration: opening a letter is a
--     signal, replying is the strongest signal. The convergence ordering
--     (replied → opened → recency) reads this table.
--   * The archive is the truth; this is the rememberer's cache. Wiping
--     and re-deriving from the letters + the client's signals yields the
--     same rows.
--   * Data minimisation: opened_at, replied_at — nothing collectable
--     that isn't required.

CREATE TABLE IF NOT EXISTS letter_reads (
    letter_id   text NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
    address_id  text NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    opened_at   timestamptz,
    replied_at  timestamptz,
    PRIMARY KEY (letter_id, address_id)
);

CREATE INDEX IF NOT EXISTS letter_reads_address_idx ON letter_reads (address_id);
