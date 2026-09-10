-- 017_door_knock.sql
-- The door-knock — the house's alert for failed logins.
--
-- A failed password attempt at a resident's door becomes a whisper to
-- that resident: "someone knocked with a key that does not fit". The
-- door itself keeps answering "the house does not know you" — the
-- knocker learns nothing; the resident learns someone tried.
--
-- House invariants enforced here:
--   * Privacy as schema: the whisper is addressed to the resident via a
--     new `target_address` column — visible iff the caller IS that
--     address. The attempted address is the only fact recorded; the
--     password is never stored, never logged, never whispered.
--   * Absence is silence: unknown addresses get no whisper — the house
--     does not whisper about doors that do not exist (no existence leak).
--   * Presence, not pressure: the whisper is a GET resource like every
--     other. The resident comes for it; nothing pushes.
--   * Rate-limited by construction: the whisper id is
--     `door-knock:<address>:<15min-bucket>` — ON CONFLICT DO NOTHING
--     means one whisper per address per window, no matter how many
--     wrong keys are tried. The log keeps the detail.
--
-- Naming note (for review before public beta): the internal kind stays
-- `door-knock`; the surface reads "a knock at the door". If the phrase
-- ever feels like a guilt trip rather than a held door, rename the
-- surface, not the schema.

ALTER TABLE whispers ADD COLUMN IF NOT EXISTS target_address text
    REFERENCES addresses(id) ON DELETE CASCADE;

ALTER TABLE whispers DROP CONSTRAINT whispers_kind_check;
ALTER TABLE whispers ADD CONSTRAINT whispers_kind_check
    CHECK (kind IN ('house-letter','gap-dormant-thread','gap-unanswered-question',
                    'gap-contradiction','gap-uncited-connection','gap-echo',
                    'gap-unvisited-corner','door-knock'));
