-- 002_threads.sql
-- Threads are correspondences. The thread is the unit, not the message.
-- NNTP-style References spine: a thread references its parent thread(s).

CREATE TABLE IF NOT EXISTS threads (
    id          text PRIMARY KEY,          -- e.g. 'th_9f2c1'
    -- References spine: the parent thread(s) this thread continues.
    -- NNTP-style: replies carry the same thread id; References is the spine.
    "references" text[] NOT NULL DEFAULT '{}',
    created_at  timestamptz NOT NULL DEFAULT now(),
    updated_at  timestamptz NOT NULL DEFAULT now()
);

-- A thread's weight is derived from its letters, not stored as a ranking.
-- No engagement metrics, no follower counts, no leaderboards.
