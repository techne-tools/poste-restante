-- 019_agents.sql
-- Agents within the house — instruments, not servants (SPEC §16).
--
-- An agent is born a letter: a `kind: "agent"` letter to `agents@house`
-- whose body is the task, the reach, the lifespan. The house ingests it,
-- validates the scope, mints the address, the token, the age + ed25519
-- keypairs (§15), and this server-side scope record. The agent's history
-- is the archive. Its state is the archive. It has no other memory.
--
-- House invariants enforced here:
--   * The reach is enumerated, not discoverable. An agent's world is
--     exactly three doors: its creator (always party), an opt-in group
--     (a thread — participation is already derived), and the pub (a
--     grant, default closed). No global address book. The server
--     enforces who the agent may address on every write.
--   * The house enforces reach, not content. The scope letter cannot be
--     sealed — the house must read the task it is policing. The agent's
--     findings may be sealed letters.
--   * Two kinds, one schema flag. House agents (rule-based automata) and
--     portal agents (external brains) share the record; `kind` is not
--     for styling, it is for server-side capability enforcement.
--   * Tasks die. Frame-scoped: when the frame closes the agent writes
--     its final letter, its token is revoked, it stops waking. No
--     zombies. Renewable only by letter — a develop of the birth thread.
--   * No self-modification. Cannot change its own scope, tools, token,
--     keys, or lifespan. Cannot mint credentials, addresses, or
--     sub-agents. Cannot whisper.
--   * No orphans: if the creator leaves, the agent dies (unless
--     bequeathed — the birth letter may name a beneficiary).

CREATE TABLE IF NOT EXISTS agents (
    address         text PRIMARY KEY REFERENCES addresses(id) ON DELETE CASCADE,
    -- The creator — a resident. Always party to the agent's letters.
    creator         text NOT NULL REFERENCES addresses(id),
    -- 'house' (rule-based automata) or 'portal' (external brain).
    kind            text NOT NULL CHECK (kind IN ('house', 'portal')),
    -- The birth letter — the archive keeps the will.
    birth_letter_id text NOT NULL REFERENCES letters(id) ON DELETE CASCADE,
    -- The task text — the house must read what it is policing.
    task            text NOT NULL,
    -- The lifespan frame (plural time): when the frame closes, the agent
    -- dies. Null = no expiry (a standing instrument).
    lifespan_frame  text,
    -- The opt-in group: a thread the agent may address. Null = none.
    group_thread    text REFERENCES threads(id) ON DELETE SET NULL,
    -- The pub grant: default closed. A standing clause or the birth
    -- letter must open it.
    pub_grant       boolean NOT NULL DEFAULT false,
    -- Bequest: a resident who may inherit the instrument on departure.
    beneficiary     text REFERENCES addresses(id),
    -- The agent's token hash (sha256) — the capability to act as the
    -- address. Revoked on death.
    token_hash      text,
    -- The agent's public keys (§15) — the house holds only the public
    -- halves; the private halves are held by the house for house agents
    -- (its own instrumentation) or by the portal for portal agents.
    age_recipient   text,
    ed25519_public  text,
    -- Lifecycle.
    created_at      timestamptz NOT NULL DEFAULT now(),
    died_at         timestamptz
);

CREATE INDEX IF NOT EXISTS agents_creator_idx ON agents (creator);
CREATE INDEX IF NOT EXISTS agents_lifespan_idx ON agents (lifespan_frame);

-- The `agent` letter kind joins the protocol (first-class because a birth
-- is a distinct act — the will — not a private letter, not a system
-- letter from the house).
ALTER TABLE letters DROP CONSTRAINT letters_kind_check;
ALTER TABLE letters ADD CONSTRAINT letters_kind_check
    CHECK (kind IN ('letter','feed','system','audio','note','task','invite','clause','leave','join','agent'));
