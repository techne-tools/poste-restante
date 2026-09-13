-- 028_seal_default.sql
-- The seal-by-default preference (design pass 2026-09-12).
--
-- Sealing is a per-letter choice, but the resident may set the desk's
-- default: when they sit down to write, the seal is already on. The house
-- stores only the preference (a boolean on the address record), never the
-- keys; the preference travels in the address record like names and
-- pronouns. Absent = false — sealing stays a deliberate per-letter choice.

ALTER TABLE addresses
    ADD COLUMN IF NOT EXISTS seal_default boolean NOT NULL DEFAULT false;
