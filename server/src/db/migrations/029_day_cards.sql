-- 029_day_cards.sql
-- The day's cards (design pass 2026-09-12).
--
-- The board (SPEC §18) is a projection of letters, agents, whispers, and
-- clauses — but the resident may also pin a single item to the day: "check
-- the rig tomorrow", "cue 147 needs a second listen". A card is NOT a
-- letter and NOT a thread — it is a single item on the board, scoped like
-- every other visibility rule. Single items, not threads; this is not the
-- pub.
--
-- Scope is derived, never a policy: 'house' is every resident, 'group' is
-- the participants of a group thread (a thread id), 'address' is one
-- address. The pub is NOT a valid scope — the pub is public, cards are
-- household-facing by design.

CREATE TABLE IF NOT EXISTS day_cards (
    id            text PRIMARY KEY,
    text          text NOT NULL,
    scope         text NOT NULL CHECK (scope IN ('house','group','address')),
    scope_value   text NOT NULL,
    frame_id      text REFERENCES frames(id) ON DELETE SET NULL,
    created_by    text NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS day_cards_scope_idx ON day_cards (scope, scope_value);
CREATE INDEX IF NOT EXISTS day_cards_frame_idx ON day_cards (frame_id);
