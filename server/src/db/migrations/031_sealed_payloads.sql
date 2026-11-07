-- 031_sealed_payloads.sql
--
-- C1 of PLAN-crypto.md: a sealed letter's enclosures are ciphertext too.
--
-- `letters.sealed` says the letter's body is age ciphertext the house cannot
-- read. Until now `letter_payloads` carried no such marker, so an enclosure
-- on a sealed letter was stored raw — the house could read what it had
-- sealed. This column makes the seal a schema property of the enclosure.
--
-- The invariant is enforced at the API, not here (postgres has no
-- cross-table CHECK without a trigger), and it holds in BOTH directions
-- because either direction leaks:
--
--   * plaintext upload to a `letters.sealed = true` row  → 422
--   * sealed upload to an unsealed row                   → 422
--
-- `content_type` for a sealed payload is `application/octet-stream`: the
-- real type travels inside the ciphertext, because the content type is
-- content ("this is a recording of the read-through") while the name and
-- size are pointers. Name and size remain visible in the catalog; that
-- metadata is accepted rather than hidden, and is stated in the card.
--
-- LEGACY: a payload attached to a sealed letter BEFORE this migration is
-- plaintext and stays `sealed = false`. The house holds no key that could
-- re-seal it, and marking it sealed would make it permanently unopenable —
-- a silent loss dressed as a fix. The DO block below reports the count so
-- an operator knows whether this archive carries any such rows.
--
-- Numbering: 030 was taken by the key-history card; this is 031.

ALTER TABLE letter_payloads
  ADD COLUMN IF NOT EXISTS sealed boolean NOT NULL DEFAULT false;

DO $$
DECLARE
  legacy bigint;
BEGIN
  SELECT count(*) INTO legacy
    FROM letter_payloads p
    JOIN letters l ON l.id = p.letter_id
   WHERE l.sealed AND NOT p.sealed;
  IF legacy > 0 THEN
    RAISE NOTICE '031: % plaintext payload(s) on sealed letters remain readable by the house (not retroactively sealed)', legacy;
  END IF;
END $$;
