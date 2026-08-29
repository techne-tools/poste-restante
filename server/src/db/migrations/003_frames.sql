-- 003_frames.sql
-- Plural time. Frames are the addresses (the human's way in); the Gregorian
-- timestamp is the index (the machine's spine).
--
-- Frames are defined by the house owner. Ships with gregorian + islamic +
-- hebrew + seasons; the owner adds production/semester/run frames. A letter can
-- be in multiple frames — handled gracefully, not duplicated.
--
-- The letter_frames join table lives in 004_letters.sql (after letters exists).

CREATE TABLE IF NOT EXISTS frames (
    id          text PRIMARY KEY,          -- e.g. 'production:tempest-2026'
    -- The frame name, e.g. 'production', 'season', 'islamic'.
    name        text NOT NULL,
    -- The value within the frame, e.g. 'tempest-2026', 'autumn', '1448-03-15'.
    value       text NOT NULL,
    created_at  timestamptz NOT NULL DEFAULT now(),
    UNIQUE (name, value)
);
