-- 025_shelve.sql
-- Put-away — the resident's own shelf (alpha 2026-09-11).
--
-- Leaving dissolves edges (migration 013): the leaver is no longer party
-- to the thread, visibility prunes itself, the house stops whispering.
-- Put-away is the gentler move: the thread is kept, the edges stand, the
-- resident stays party — but the thread is not in the mailbox, and the
-- house stops offering it. It is a shelf, not a door. Like leave, the
-- act IS a letter: `shelve` and `unshelve` are first-class letter kinds,
-- the archive keeps the history, "current" is derived.
--
-- House invariants enforced here:
--   * Consent is reversible: a shelf is a state, not a deletion. The
--     thread and the letters stay; the resident may bring it back at any
--     time (unshelve). Nothing is destroyed.
--   * Privacy as schema: participation is still derived from the letters.
--     `shelved` is a third participation state — party, but put away.
--     Visibility (can you still read the thread) is unchanged — the
--     edges stand; only the mailbox and the whisper stop offering it.
--   * The book is exempt: clause threads are commons by right — you
--     cannot shelf the household's knowing of itself. Shelve/unshelve on
--     clause threads is refused at the route, like leave/join.

-- The third participation state.
ALTER TABLE thread_participation DROP CONSTRAINT IF EXISTS thread_participation_state_check;
ALTER TABLE thread_participation ADD CONSTRAINT thread_participation_state_check
    CHECK (state IN ('in','out','shelved'));

-- The `shelve` and `unshelve` letter kinds (first-class because putting
-- away is a distinct act — the resident's own will — not a private
-- letter, not a system letter from the house).
ALTER TABLE letters DROP CONSTRAINT letters_kind_check;
ALTER TABLE letters ADD CONSTRAINT letters_kind_check
    CHECK (kind IN ('letter','feed','system','audio','note','task','invite','clause','leave','join','agent','rename','shelve','unshelve'));
