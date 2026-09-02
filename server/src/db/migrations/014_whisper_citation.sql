-- 014_whisper_citation.sql
-- The whisper's citation of the book (SPEC §5.8 related).
--
-- When the house offers a gap, it may also cite a clause the household has
-- already held that bears on the matter. The citation is a pointer, not a
-- verdict: the house is not saying the clause decides anything — it is
-- saying "we have held this; want to look?" The book offers, never
-- invokes.
--
-- Two columns, both nullable:
--   * cited_clause  — the clause thread the whisper points at. A whisper
--     cites at most one clause (generosity, quiet — the house offers a
--     few, not exhaustively).
--   * cited_excerpt — the clause's current text, truncated, so the
--     sidebar is self-contained and the resident can see what the
--     household held without leaving the whisper.
--
-- Privacy as schema: the book is commons by right — every resident reads
-- it — so citing a clause leaks nothing. No new visibility limb is
-- needed: the citation points at the household's knowing of itself, which
-- the resident already holds by right.
--
-- The citation is derived, like everything else: it is written when the
-- whisper is created (the gap pass embeds the whisper's own summary and
-- searches the semantic layer for a standing clause that shares ground).
-- Wiping the columns and re-running the pass yields the same citations.

ALTER TABLE whispers ADD COLUMN IF NOT EXISTS cited_clause text
    REFERENCES threads(id) ON DELETE SET NULL;

ALTER TABLE whispers ADD COLUMN IF NOT EXISTS cited_excerpt text;
