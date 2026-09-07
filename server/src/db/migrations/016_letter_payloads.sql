-- 016_letter_payloads.sql
-- The payload catalog — what a letter carries beyond its body.
--
-- The MinIO tier already holds the bytes (`letters/<letterId>/<name>`);
-- this table is the *pointer* layer, and it exists for a data-minimisation
-- reason: the house cannot say what a payload is (its content type, its
-- size, whether it is an image that may render inline) without asking the
-- object store. A catalog makes the payload's shape a schema property —
-- derived visibility stays exactly as it was (every payload route is still
-- gated by the same letter-visibility checks), and the pointer dies with
-- the letter (ON DELETE CASCADE), never orphaning the archive's knowing.
--
-- House invariants held:
--   * Data minimisation — name, content_type, size. No thumbnails, no
--     provenance, no engagement counts. If a field isn't needed to render
--     the payload, it doesn't exist.
--   * Privacy — this table adds no new visibility axis. The catalogue is
--     meaningful only to someone who can already see the letter; the
--     routes that read it enforce the same isVisibleTo checks as the
--     letter routes.
--   * Deletion is first-class — deleting the letter deletes the pointers
--     here (and the pipeline cascades to the MinIO objects themselves).
CREATE TABLE IF NOT EXISTS letter_payloads (
    letter_id    text NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
    name         text NOT NULL,
    content_type text NOT NULL DEFAULT 'application/octet-stream',
    size         bigint NOT NULL DEFAULT 0,
    created_at   timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (letter_id, name)
);

CREATE INDEX IF NOT EXISTS letter_payloads_letter_idx ON letter_payloads (letter_id);
