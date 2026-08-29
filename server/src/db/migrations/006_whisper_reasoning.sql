-- 006_whisper_reasoning.sql
-- The offer shows its reasoning (interaction contract: "Every offer shows its
-- reasoning, expandable — 'here's what I was seeing'"). The house's offers
-- carry a reasoning field; the client renders it as an expandable disclosure.
-- Nullable: not every whisper has reasoning to show (e.g. structural gaps).

ALTER TABLE whispers ADD COLUMN IF NOT EXISTS reasoning text;
