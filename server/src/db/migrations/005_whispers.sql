-- 005_whispers.sql
-- The whisper — the mailbox for the house's own letters.
--
-- The house writes letters too: summaries, questions, observations, gap
-- offers. They are correspondence, not metadata. The whisper surfaces them
-- when relevant and stays quiet when not.
--
-- House invariants enforced here:
--   * Presence not pressure: the whisper is a GET resource. There is NO push
--     channel — no notification table, no delivery ping. The client comes for
--     it. The schema makes push unrepresentable.
--   * The learning loop is the collaboration: opening a whisper is a signal,
--     explicit dismissal is the strongest negative, writing back is the
--     strongest positive. State is recorded, never broadcast.
--   * Data minimisation: only the state the loop needs — opened, dismissed,
--     replied. Nothing collectable that isn't required.

CREATE TABLE IF NOT EXISTS whispers (
    id            text PRIMARY KEY,   -- deterministic: sha256(kind:target:date)
    letter_id     text REFERENCES letters(id) ON DELETE CASCADE,
    kind          text NOT NULL CHECK (kind IN
                    ('house-letter','gap-dormant-thread','gap-unanswered-question')),
    target_thread text,               -- the thread the whisper points at
    summary       text NOT NULL,
    created_at    timestamptz NOT NULL DEFAULT now(),
    opened_at     timestamptz,        -- the user opened it (signal: opened)
    dismissed_at  timestamptz,        -- explicit dismissal (strongest negative)
    replied_at    timestamptz         -- the user wrote back (strongest signal)
);

CREATE INDEX IF NOT EXISTS whispers_created_idx ON whispers (created_at DESC);
