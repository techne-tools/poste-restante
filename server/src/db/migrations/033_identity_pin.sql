-- 033_identity_pin.sql
-- The identity is durable; the key is material it holds over time (SPEC §19,
-- amended 2026-11-08).
--
-- 022 said two things at once and only one of them was ever true in the code:
-- "The key never changes; the label can" AND "The identity id is the CURRENT
-- key's fingerprint." 023 built on the second one — "Key rotation: the binding
-- re-establishes to the new key" — and so did `setAddressIdentity()`, which
-- overwrote `addresses.identity_id` with the new fingerprint on EVERY key
-- registration. The consequence, invisible while nobody rotated: a rotation
-- moved every letter id that named the rotated address, because the id resolves
-- handles to identity ids. A sealed letter re-delivered after a party OTHER
-- than the sender had rotated could not be re-derived at all (030's recorded
-- limitation) and was rejected.
--
-- THE RESOLUTION (Chris, 2026-11-08): the identity is the address's durable
-- identity. `addresses.identity_id` is set ONCE — at the address's first key
-- registration, to that key's ed25519 fingerprint — and never moves afterwards.
-- A key is material the address holds over time: rotation retires it
-- (030: append-only `address_keys`) and appends the next, and no letter id
-- moves. Letter ids are now stable against ANY party's rotation, not only the
-- sender's. The OIDC binding is created against the identity and survives
-- rotation unchanged, because there is nothing left to re-establish.
--
-- What this migration does, and why each part is safe:
--
--   * The binding follows its identity. `oidc_bindings.identity_id` referenced
--     `addresses(identity_id)` with no ON UPDATE clause, so re-keying an
--     address's identity while a binding named the old value raised a foreign
--     key error (`setAddressIdentity()` would 500 for any address that had
--     bound OIDC before registering keys — a latent defect, not a hypothetical
--     one). ON UPDATE CASCADE is the right shape for the new semantics: the
--     binding names the identity, so when the identity is re-keyed the binding
--     travels with it rather than being severed.
--
--   * Identities that are still just handles are pinned to the key the resolver
--     has been using. Every path that registers keys through the route already
--     wrote a fingerprint here; the house's own mirror (`house/keys.ts`,
--     `house@house`) did not, and a fresh database would leave it resolving to
--     a handle. This statement makes `identity_id` agree with the resolver for
--     every address that holds a key — which is what makes the change
--     BEHAVIOUR-NEUTRAL on the day it applies: no letter id derived today
--     moves tomorrow. Addresses that hold no key are left alone; their identity
--     stays their handle, which is what a keyless legacy address resolves to.
--     (The predicate is "the identity is not a key this address has ever held",
--     which also catches an address that was relabelled before it registered.)
--
-- THE TRANSITION RULE — and the mixed archive it leaves.
--
--   * An address that registered once and never rotated: `identity_id` already
--     equals its first key. Nothing moves, then or later.
--
--   * An address that HAS rotated before this migration: `identity_id` holds
--     the key it registered last — the pin point, and the key the resolver was
--     using. From here on it never moves again.
--
--   * Letters already written are NOT re-derived, and cannot be. A sealed
--     letter's id is what its ed25519 signature covers, and the house holds no
--     private key to re-sign with; re-deriving ids would also orphan
--     `letter_addresses`, `letter_frames`, the payload catalog and the Qdrant
--     points. So the archive is PINNED going forward and MIXED for anything
--     already written: stored ids never move, and verification accepts both the
--     pinned id (`resolvePinnedId`) and the pre-pin resolution
--     (`resolveSignedId`, walked through the sender's key history).
--
--     The residue is named rather than hidden: a pre-pin sealed letter that is
--     re-delivered after a party OTHER than the sender has rotated still cannot
--     be re-derived, and is rejected — but it was already stored, and nothing
--     in the archive depends on the re-derivation. Re-seal and re-sign if a
--     fresh copy is wanted.
--
--   * No re-index is run here. If an id re-derivation is ever wanted it is its
--     own plan with its own backup story (it cannot re-sign, and it moves every
--     pointer in the house).
--
-- Verified behaviour after this migration: first registration pins;
-- `identity_id` is unchanged by any later registration while `address_keys`
-- grows a row per generation with exactly one live row; a sealed letter naming
-- a rotated recipient re-delivers to its original id; a letter sealed by a
-- client that predates the `identityId` wire field still verifies.

-- The binding travels with its identity instead of blocking a re-key.
ALTER TABLE oidc_bindings DROP CONSTRAINT IF EXISTS oidc_bindings_identity_id_fkey;
ALTER TABLE oidc_bindings
  ADD CONSTRAINT oidc_bindings_identity_id_fkey
  FOREIGN KEY (identity_id) REFERENCES addresses (identity_id)
  ON UPDATE CASCADE ON DELETE CASCADE;

-- Pin the identities that are still handles while the address holds a key: the
-- key it holds NOW is what the resolver has been using, so this moves nothing
-- and only makes the column say what the house was already resolving to.
UPDATE addresses a
   SET identity_id = k.ed25519_public
  FROM address_keys k
 WHERE k.address = a.id
   AND k.retired_at IS NULL
   AND NOT EXISTS (
     SELECT 1 FROM address_keys h
      WHERE h.address = a.id AND h.ed25519_public = a.identity_id
   );
