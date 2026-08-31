-- 008_invites.sql
-- Invitation-only membership — the invite letter (SPEC §5.7).
--
-- Joining the house is invitation-only, and the join flow is a letter, not a
-- CLI ceremony. A resident mints an address (dormant — a row in the social
-- graph, no credential) and writes a `kind: "invite"` letter to it. The guest
-- is told about the letter out of band (the house never pushes); redeeming
-- proves possession of the letter and presents the one-time code, and the
-- house issues a credential the guest sets themselves.
--
-- House invariants enforced here:
--   * Privacy as schema: the table stores only `code_hash`, never the code.
--     The code itself lives in the invite letter's body — the archive's
--     participation scoping (only the addressee can read it) is stronger
--     privacy than any out-of-band delivery.
--   * First-class deletion: revocation is just deletion of the letter (the
--     invite row CASCADEs away). No revoke flag.
--   * One-time: `redeemed_at` is set atomically; a redeemed invite is spent.
--   * Anti-hierarchy: no admin role. `created_by` is a peer vouching for a
--     new resident; v1 restricts minting to the owner via the CLI, but the
--     schema itself is unchanged if any resident may invite later.

CREATE TABLE IF NOT EXISTS invites (
    -- The invite letter is the key. Deleting the letter revokes the invite.
    letter_id    text PRIMARY KEY REFERENCES letters(id) ON DELETE CASCADE,
    -- The resident who vouched (the letter's sender).
    created_by   text NOT NULL REFERENCES addresses(id) ON DELETE CASCADE,
    -- sha256 hex of the one-time code. The code itself is never stored.
    code_hash    text NOT NULL,
    -- Nullable: an invite may be timeless (the house holds, it never pings).
    expires_at   timestamptz,
    -- Nullable: set once, atomically — a redeemed invite is spent.
    redeemed_at  timestamptz,
    redeemed_by  text REFERENCES addresses(id) ON DELETE SET NULL
);

-- Invites can only be redeemed while the letter exists and is unredeemed.
CREATE INDEX IF NOT EXISTS invites_code_hash_idx ON invites (code_hash);
CREATE INDEX IF NOT EXISTS invites_created_by_idx ON invites (created_by);

-- The `invite` letter kind (SPEC §5.7: first-class because redemption is
-- one-time state a frame can't carry, and it is a capability granted by a
-- peer, distinct from `system` letters that come from the house).
ALTER TABLE letters DROP CONSTRAINT letters_kind_check;
ALTER TABLE letters ADD CONSTRAINT letters_kind_check
    CHECK (kind IN ('letter','feed','system','audio','note','task','invite'));
