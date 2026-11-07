# PLAN: SPEC §5 #15 — Values-aligned crypto (client-held sealed letters)

Status: planning only. No code yet. House speaks ciphertext only.

## Outcomes
- All letter bodies persisted as ciphertext at rest. Two seal levels:
  (a) sealed letters cryptographically hold even against a compromised house
  (b) unsealed letters are sealed to the house envelope key (operator can still read).
- The house never holds a master key; only its own participant keypair (age + ed25519).
- Consent reversible at every level: per-letter seal, per-correspondent default, always-available override, relationship pause.

## Phases

1. **Keystores.** Each resident (incl. house) holds an age (+ optional ed25519) keypair. House provisioning (operator-held backup of *only* the house's own key). Distribution of correspondent keys: in-band via a "keyletter" (a letter carrying a pubkey frame).
2. **Envelope encryption.** New column `body_ciphertext BYTEA` (or letter body becomes ciphertext with `seal` flag). MinIO payload encryption for sealed attachments.
3. **The seal schema.**
   - `letters.seal_level ∈ {none, house, sealed}`
   - For sealed letters: subject moves into the body (no metadata leak); no FTS/embedding/IMAP materialization; no whisper consumption.
   - `collaboration-grant` edge table for reinstating sealed-letter visibility.
4. **Cryptography primitives.** age with recipient(s) = all parties + house (for sealed? house gets NO key — house is excluded for sealed-letters; the "house as participant" applies to unsealed only). For unsealed: house + parties.
5. **Crypto migration.** Existing letters → house-sealed re-encryption (key-history approach: keys carry a generation suffix; re-encrypt on key rotation optional).
6. **House's own letters.** House whisper can only inspect unsealed letters; sealed letters never surface.
7. **Verification.** Prove sealed letters are opaque to a DB dump; prove server never derives body; prove whisper skips.

## Risks
- Without federation (matrix/AP), key distribution is in-band only.
- Recovery keys & operator backup key (SPEC §15) need documented offline procedure.
- Cross-client compatibility for age ed25519.

## Non-goals
- No database-level TDE.
- No key escrow for sealed letters.