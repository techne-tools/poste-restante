-- 009_whisper_related_letter.sql
-- The theatrical gaps — the resident's eye (SPEC §2.4).
--
-- Three of the four remaining gap types are about PAIRS of letters, not a
-- single thread:
--   * gap-contradiction   — two voices in one thread ("two voices", surfaced
--     as such: being-with is not being-the-same-as — the house holds the
--     space between, it never adjudicates)
--   * gap-uncited-connection — two letters in different threads share ground
--     without citing one another
--   * gap-echo            — the same thing said twice in different words;
--     the work is circling
--
-- The pair is expressed as two columns, not a join table: `letter_id` (the
-- whisper's anchor — where the resident lands and writes back) and
-- `related_letter_id` (the letter the house is connecting it to). The whisper
-- stays a single offer: one summary, one reasoning, at full weight on both
-- sides. A join table would model the pair as an object; the house models it
-- as an interval.
--
-- House invariants enforced here:
--   * Privacy as schema: a whisper about a pair is only visible to an address
--     party to BOTH letters. The visibility predicate in the service derives
--     from letter_addresses (the social graph) — the house never gossips
--     about a letter you are not party to, even as half of a connection.
--   * The house holds, it does not adjudicate: the contradiction surface
--     carries no verdict. Both voices stay at full weight; the schema keeps
--     them apart (two columns), so the client cannot merge them by accident.
--   * Convergence by construction: the detection writers only create
--     whispers whose pair is within the caller's own participation set.
--
-- Naming note (for review before public beta): the internal kind stays
-- `gap-contradiction` for SPEC continuity; the surface reads "two voices".
-- If the split ever feels like a lie rather than a discipline, rename the
-- kind outright.

ALTER TABLE whispers ADD COLUMN IF NOT EXISTS related_letter_id text
    REFERENCES letters(id) ON DELETE CASCADE;

ALTER TABLE whispers DROP CONSTRAINT whispers_kind_check;
ALTER TABLE whispers ADD CONSTRAINT whispers_kind_check
    CHECK (kind IN ('house-letter','gap-dormant-thread','gap-unanswered-question',
                    'gap-contradiction','gap-uncited-connection','gap-echo'));
