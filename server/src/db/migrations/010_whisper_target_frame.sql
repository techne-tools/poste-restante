-- 010_whisper_target_frame.sql
-- The unvisited corner — the resident's eye, completed (SPEC §2.4, SKETCH.md
-- "the unexamined corner of the material").
--
-- The fifth gap type is FRAME-scoped, not thread-scoped: a region of the
-- frame's territory with no letters — `production:tempest-tech-week` has
-- gone quiet while `production:next-show` still moves. The whisper carries
-- a single frame reference instead of a thread or a letter pair:
--
--   * `gap-unvisited-corner` — a frame the caller worked in, quiet 30 days,
--     while at least one of the caller's other frames moved within a
--     fortnight. The house is not telling the resident to go back; it is
--     holding the empty room open.
--
-- The schema stays minimal: one nullable `target_frame` column (FK to
-- frames, cascade), and the kind CHECK gains the new kind. The whisper
-- remains a single offer — one summary, one reasoning — anchored on the
-- room, not on any one letter.
--
-- House invariants enforced here:
--   * Privacy as schema: a corner whisper is only visible to an address
--     party to at least one letter in the frame — the territory is proven
--     through letter_frames × letter_addresses (the social graph), never a
--     runtime check. The house never whispers about a room you have never
--     entered.
--   * Presence, not pressure: the frame grows quiet and the house holds
--     it. Dismissal is respected — the re-offer window is 7 days, like the
--     other gaps.
--   * No new table: a join table would model the corner as an object; the
--     house models it as a reference. `target_frame` IS the offer.
--
-- Naming note (for review before public beta): the internal kind stays
-- `gap-unvisited-corner` for SPEC §2.4 continuity; the surface reads
-- "an unvisited corner". If the phrase ever feels like a guilt trip rather
-- than an invitation, rename the surface, not the schema.

ALTER TABLE whispers ADD COLUMN IF NOT EXISTS target_frame text
    REFERENCES frames(id) ON DELETE CASCADE;

ALTER TABLE whispers DROP CONSTRAINT whispers_kind_check;
ALTER TABLE whispers ADD CONSTRAINT whispers_kind_check
    CHECK (kind IN ('house-letter','gap-dormant-thread','gap-unanswered-question',
                    'gap-contradiction','gap-uncited-connection','gap-echo',
                    'gap-unvisited-corner'));
