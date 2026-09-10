-- 020_integrations.sql
-- External tool integration for agents — how the house safely permits MCP
-- (SPEC §17, direction B: house → external MCP server).
--
-- Correspondence is the floor; integrations are grants — never defaults,
-- never self-granted. An agent calls external tools *through* the house.
--
-- House invariants enforced here:
--   * Registered, not discovered. Agents never talk to arbitrary URLs.
--     The house proxies only *registered* integrations — address ↔ MCP
--     server URL ↔ pinned version. SSRF dead by construction: the house
--     never fetches an agent-provided URL. Registration is an operator
--     act, like installing a sidecar.
--   * Tool whitelist per scope. A registered integration exposes N tools;
--     the scope record whitelists which. Enumerated, not discoverable —
--     the same rule as the reach (§16). An agent cannot add tools to
--     itself; scope creep is a creator's develop letter.
--   * Bounded calls. Every call has a hard timeout, a rate limit, and a
--     per-frame budget. The house holds; it never interrupts.
--   * Every call is an audit letter. One letter per toolcall — event id,
--     tool, timestamp — addressed to the creator and the agent itself,
--     never the pub. The args are ephemeral: passed to the server, never
--     stored; there is no args column, schema-level data minimisation.
--   * Credential isolation. Integration credentials are age-encrypted at
--     rest (§15); the house passes them to the server at call time. The
--     agent never sees a shared credential; the integration never sees
--     the house's keys.
--   * The book binds the doors. `enabled` is a bindable door: a standing
--     clause can retire a tool house-wide, cap integrations per resident,
--     close the whole seam. The book outranks the creator.
--   * v1 remote-only. Operator-registered remote servers only; the house
--     never runs integration code in-process.

CREATE TABLE IF NOT EXISTS integrations (
    id              text PRIMARY KEY,          -- e.g. 'web-search'
    -- The MCP server URL — operator-registered, pinned. The house never
    -- fetches an agent-provided URL.
    url             text NOT NULL,
    -- The pinned version (the sidecar-pin precedent, v0.16.20).
    version         text NOT NULL,
    -- The tool catalog — what this integration exposes. JSON array of
    -- { name, description, verbs } — enumerated, not discoverable.
    tools           jsonb NOT NULL DEFAULT '[]'::jsonb,
    -- The bindable door: a standing clause can close the whole seam.
    enabled         boolean NOT NULL DEFAULT true,
    -- Integration credentials, age-encrypted at rest (§15). The house
    -- passes them to the server at call time; the agent never sees them.
    credentials_enc text,
    created_at      timestamptz NOT NULL DEFAULT now()
);

-- The per-agent tool whitelist — the instrument's constitution.
CREATE TABLE IF NOT EXISTS agent_integrations (
    agent_address   text NOT NULL REFERENCES agents(address) ON DELETE CASCADE,
    integration_id  text NOT NULL REFERENCES integrations(id) ON DELETE CASCADE,
    -- The whitelisted tool names (subset of the integration's catalog).
    tools           text[] NOT NULL DEFAULT '{}',
    -- Per-frame budget: how many calls this agent may make per frame.
    frame_budget    integer NOT NULL DEFAULT 100,
    PRIMARY KEY (agent_address, integration_id)
);

CREATE INDEX IF NOT EXISTS integrations_enabled_idx ON integrations (enabled);
CREATE INDEX IF NOT EXISTS agent_integrations_agent_idx ON agent_integrations (agent_address);
