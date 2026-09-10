-- 023_oidc_bindings.sql
-- OIDC is a door, not an identity (SPEC §19, resolved 2026-09-10).
--
-- At-will identity change and OAuth are not naturally compatible: OAuth
-- makes the provider the identity authority, §19 makes the key the
-- identity authority. The collision is structural — the provider's `sub`
-- is a stable link to a person, exactly what at-will change must be able
-- to sever.
--
-- The resolution: the house's identity is the key; OIDC is one way to
-- prove you hold the key. The binding is
--   provider sub → identity_id (key fingerprint) → current handle
-- never `sub → handle`.
--
-- House invariants enforced here:
--   * The gate and the identity are different axes. The house polices
--     the first (who gets in), never the second (who you are once in).
--   * Handle change: the binding survives — the key is the continuity.
--   * Provider change: the new provider's sub binds to the same
--     identity_id.
--   * Key rotation: the binding re-establishes to the new key (the §15
--     key-history rule).
--   * Scrub: the handle is scrubbed, the key rotated, the OIDC binding
--     re-established to the new key — the provider link is severed with
--     the old identity.
--   * Privacy as schema: the binding stores only the provider sub and
--     the identity id — never the id_token, never the access token.

-- One identity = one address row (the address IS the person; the handle
-- is a label). The FK below needs a UNIQUE target.
CREATE UNIQUE INDEX IF NOT EXISTS addresses_identity_id_unique
    ON addresses (identity_id);

CREATE TABLE IF NOT EXISTS oidc_bindings (
    identity_id text NOT NULL REFERENCES addresses(identity_id) ON DELETE CASCADE,
    provider    text NOT NULL,          -- e.g. 'voidauth'
    sub         text NOT NULL,          -- the provider's subject identifier
    created_at  timestamptz NOT NULL DEFAULT now(),
    PRIMARY KEY (provider, sub)
);

CREATE INDEX IF NOT EXISTS oidc_bindings_identity_idx ON oidc_bindings (identity_id);
