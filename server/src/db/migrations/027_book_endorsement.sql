-- 027_book_endorsement.sql
-- The endorsement chain (design pass 2026-09-12).
--
-- An offered or developed norm does not enter the commons by time alone:
-- it must be SUPPORTED. Standing now requires the settling period to
-- elapse with no open stop AND at least one support that endorses the
-- offer itself (directly, or through the offer's first develop — rule 11:
-- supporting a development of an offer endorses the original offer).
--
-- A support of a development-of-a-development endorses that develop, not
-- the offer — so a develop-of-develop cannot float the original offer
-- into the commons until the offer itself lands. `supports_toward_standing`
-- is that landing pool: supports whose endorsement target sits at chain
-- depth 0 (the offer) or depth 1 (its first develop). The cache records
-- the count so the head can answer "can this stand?" without re-deriving.

ALTER TABLE clauses
    ADD COLUMN IF NOT EXISTS supports_toward_standing integer NOT NULL DEFAULT 0;
