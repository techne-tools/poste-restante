-- 007_credentials.sql
-- Credentials — the house's authentication layer.
--
-- Identity = address. There is no separate user table: an address that can
-- *act* has credentials; an address that merely exists in the social graph
-- (a correspondent) does not. The owner issues credentials; the house never
-- auto-creates identities.
--
-- House invariants enforced here:
--   * Privacy as schema: the social graph (addresses) and the secrets
--     (credentials) never share a table. A credential row holds only what
--     authentication needs — a hash, never a password.
--   * Anti-hierarchy: no admin class, no roles. A credential is a capability
--     to act as that address. The first credential is bootstrapped by the
--     owner via the CLI; there is no "admin" flag.
--   * Data minimisation: scrypt hash + salt (Node's built-in scrypt), or an
--     opaque bearer token hash. OIDC bindings store only the provider `sub`
--     — never the id_token, never the access token.

CREATE TABLE IF NOT EXISTS credentials (
    address     text PRIMARY KEY REFERENCES addresses(id) ON DELETE CASCADE,
    -- 'password' (scrypt hash), 'token' (opaque bearer token hash), or
    -- 'oidc' (provider subject binding; secret is empty).
    kind        text NOT NULL CHECK (kind IN ('password', 'token', 'oidc')),
    -- For kind='password': scrypt hash in the format
    --   scrypt$N$r$p$salt$hash   (all hex/base64, Node crypto.scryptSync)
    -- For kind='token': sha256 hex of the opaque token.
    secret      text NOT NULL,
    -- OIDC binding: the provider's subject identifier for this address.
    -- An address may have at most one OIDC binding (unique constraint).
    oidc_sub    text UNIQUE,
    created_at  timestamptz NOT NULL DEFAULT now(),
    last_used_at timestamptz
);

CREATE INDEX IF NOT EXISTS credentials_address_idx ON credentials (address);
