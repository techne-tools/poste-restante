-- 004_letters.sql
-- The letters. Envelope + body. The unit of the house in all three tiers
-- (postgres row, qdrant vector, minio file).
--
-- House invariants enforced here:
--   * Data minimisation is the schema: the envelope has exactly the fields a
--     letter needs for delivery. If a field isn't required, it doesn't exist.
--   * Presence not pressure: there is NO push channel in the schema. No
--     notification table, no read-receipt, no delivery ping. The letter waits.
--     The schema makes push unrepresentable.
--   * Deletion is first-class: any letter can be deleted by sender or
--     recipient. No soft delete. The archive forgets on request.
--   * Anti-hierarchy: no owner field, no ranking, no engagement metrics.

CREATE TABLE IF NOT EXISTS letters (
    id          text PRIMARY KEY,          -- sha256 of envelope+body
    -- Envelope fields, exactly as the contract specifies.
    from_addr   text NOT NULL,             -- the sender's address
    to_addrs    text[] NOT NULL DEFAULT '{}',
    cc_addrs    text[] NOT NULL DEFAULT '{}',
    thread_id   text NOT NULL REFERENCES threads(id) ON DELETE CASCADE,
    kind        text NOT NULL CHECK (kind IN ('letter','feed','system','audio','note','task')),
    lang        text NOT NULL DEFAULT 'en-AU',
    subject     text NOT NULL DEFAULT '',
    -- Body.
    body        text NOT NULL,             -- markdown
    body_text   text NOT NULL DEFAULT '',  -- plain text extracted for FTS/embedding
    -- Plural time: the Gregorian timestamp is the index (sort key, sync cursor).
    received_at timestamptz NOT NULL,
    -- Explicit pin (house ranking signal). Nullable; a letter is pinned or not.
    pinned_at   timestamptz,
    pinned_by   text,
    created_at  timestamptz NOT NULL DEFAULT now()
);

-- The Gregorian timestamp is the machine's spine — the sort key and sync cursor.
CREATE INDEX IF NOT EXISTS letters_received_at_idx ON letters (received_at DESC);

-- Exact retrieval: "the letter from ben on the 29th".
CREATE INDEX IF NOT EXISTS letters_from_idx ON letters (from_addr);
CREATE INDEX IF NOT EXISTS letters_thread_idx ON letters (thread_id);
CREATE INDEX IF NOT EXISTS letters_kind_idx ON letters (kind);

-- Full-text retrieval: "the letter where we discussed the sound design".
-- English config is the default; the house is i18n-aware via the lang field,
-- but FTS config is a per-deployment choice. We index the plain-text body.
CREATE INDEX IF NOT EXISTS letters_body_fts_idx
    ON letters USING GIN (to_tsvector('english', body_text));

-- Correspondents: a letter is linked to every address in from/to/cc.
-- This is the social graph edge table (the address book is the graph).
CREATE TABLE IF NOT EXISTS letter_addresses (
    letter_id   text NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
    address_id  text NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    role        text NOT NULL CHECK (role IN ('from','to','cc')),
    PRIMARY KEY (letter_id, address_id, role)
);

CREATE INDEX IF NOT EXISTS letter_addresses_address_idx ON letter_addresses (address_id);

-- A letter's membership in frames. A letter can be in many frames — handled
-- gracefully, not duplicated.
CREATE TABLE IF NOT EXISTS letter_frames (
    letter_id   text NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
    frame_id    text NOT NULL REFERENCES frames(id) ON DELETE CASCADE,
    PRIMARY KEY (letter_id, frame_id)
);

CREATE INDEX IF NOT EXISTS letter_frames_frame_idx ON letter_frames (frame_id);
