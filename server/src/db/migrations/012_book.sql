-- 012_book.sql
-- The house book (SPEC §5.8) — the commons made structural.
--
-- The book is a thread, not a table. An offered norm is a letter to
-- book@house; the develop is the correspondence; the book's head is the
-- current constitution, DERIVED from the thread, never declared by a keeper.
--
-- This table is the rememberer's cache: it holds the derived head so the
-- house can answer "what does the household hold?" without re-deriving the
-- whole thread on every read. Wiping it and re-deriving from the thread
-- yields the same head — the thread is the source of truth, the table is
-- the cache. The house is the rememberer and citier, never the author.
--
-- House invariants enforced here:
--   * Anti-hierarchy: no admin class, no tribunal. A clause is a thread;
--     any resident may offer, any may stop. The state machine is
--     mechanical — the house enforces stated will, never inferred will.
--   * Consent-forward: no and yes are equally significant. Stop is a safe
--     word, solidly grounded — a stop reopens the clause as two voices
--     and contested never stands. The vocabulary is the household's own
--     (offer, develop, stop, support, set aside), not parliamentary.
--   * Develops are reversals, not erasures: the archive keeps the history;
--     "current" is derived. Reversal is a role, not a deletion.
--   * Ratification is slow by construction: a clause stands only after a
--     settling period with no open stop. A stop reopens it as two
--     voices — divergence held, never adjudicated.
--   * Bound doors are the only mechanics: a ratified clause may bind a
--     door (v1: the pub's is_public). Enforcement is collective, slow,
--     revisable, mechanical — there is no ban button.
--   * Privacy as schema: the book is commons by right — every resident
--     reads it — but it is NOT a keyless door. Guests are not residents;
--     the book is the household's knowing of itself.
--
-- The `clause` letter kind joins the protocol (SPEC §5.8: first-class
-- because a norm is a distinct act — a capability the household holds —
-- not a private letter, not a system letter from the house).

CREATE TABLE IF NOT EXISTS clauses (
    -- The thread IS the clause. One clause per thread; amendments continue
    -- the thread (the correspondence is the develop).
    thread_id    text PRIMARY KEY REFERENCES threads(id) ON DELETE CASCADE,
    -- The current text of the clause (derived from the latest
    -- proposal/amendment/reversal, frontmatter stripped).
    text         text NOT NULL,
    -- The resident who proposed the current text.
    proposed_by  text NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    -- The letter that proposed the current text.
    proposed_in  text NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
    -- The derived state. 'reversed' is terminal until an amendment
    -- re-proposes the clause.
    state        text NOT NULL CHECK (state IN ('proposed','contested','standing','reversed')),
    -- The settling clock: the time of the latest offer/develop, or of
    -- the set aside that cleared the last stop. A clause stands when
    -- settling_from + settling_days has passed with no open stop.
    settling_from timestamptz NOT NULL,
    -- True when the current text came from a reversal — when it settles it
    -- becomes 'reversed', not 'standing'.
    pending_reversal boolean NOT NULL DEFAULT false,
    -- The time the clause stood (settling_from + settling_days, deterministic).
    stood_at     timestamptz,
    -- The time the clause was reversed (nullable: not reversed).
    reversed_at  timestamptz,
    -- The letter that reversed the clause (the reversal that stood).
    reversed_in  text REFERENCES letters(id) ON DELETE SET NULL,
    -- Open stops (distinct residents who stop the current text). A stop is
    -- a safe word — no and yes are equally significant; contested never
    -- stands.
    objections   integer NOT NULL DEFAULT 0,
    -- Supports for the current text (distinct residents). Weight orders
    -- what the house SAYS, never what the house DOES.
    vouches      integer NOT NULL DEFAULT 0,
    -- The door this clause binds, if any. v1: 'pub@house.is_public' only.
    -- Nullable: a norm may be unbound — it orders what the house says,
    -- never what the house does.
    binding_door text,
    -- The value the door is bound to when the clause stands.
    binding_value boolean,
    -- On a reversal offer: the thread this offer reverses when it
    -- stands. Nullable: only reversal offers carry a target.
    reverses_thread text REFERENCES threads(id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS clauses_state_idx ON clauses (state);

-- Distinct-resident stops and supports for the current text of a clause.
-- The counts in `clauses` are derived from these sets — a resident stopping
-- twice is one stop, not two. The sets are cleared when the text changes
-- (develop/offer) and re-derived from the thread's letters.
CREATE TABLE IF NOT EXISTS clause_objectors (
    thread_id text NOT NULL REFERENCES clauses(thread_id) ON DELETE CASCADE,
    address   text NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    PRIMARY KEY (thread_id, address)
);

CREATE TABLE IF NOT EXISTS clause_vouchers (
    thread_id text NOT NULL REFERENCES clauses(thread_id) ON DELETE CASCADE,
    address   text NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    PRIMARY KEY (thread_id, address)
);

-- The book is a resident address, like the pub — but its door is NOT open.
-- The book is commons by right (every resident reads it), never a keyless
-- door. Guests are not residents; the book is the household's knowing of
-- itself.
INSERT INTO addresses (id) VALUES ('book@house')
ON CONFLICT (id) DO NOTHING;

-- The `clause` letter kind (SPEC §5.8: first-class because a norm is a
-- distinct act — a capability the household holds — not a private letter,
-- not a system letter from the house).
ALTER TABLE letters DROP CONSTRAINT letters_kind_check;
ALTER TABLE letters ADD CONSTRAINT letters_kind_check
    CHECK (kind IN ('letter','feed','system','audio','note','task','invite','clause'));
