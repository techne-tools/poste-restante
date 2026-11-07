# age interop fixtures

Two ciphertexts of the same sentence, sealed by two different implementations,
plus the identity that opens both. `test/unit/age-interop.test.ts` consumes them.

| File | What it is |
|---|---|
| `plaintext.txt` | The sealed sentence, UTF-8, trailing newline included. |
| `identity.txt` | The age identity (X25519) that opens both fixtures. **A fixture key**: it guards nothing but these files, which is why it is committed. Never reuse it for a real letter. |
| `recipient.txt` | The matching recipient, as `age-keygen -y identity.txt` prints it. |
| `reference.age` | `plaintext.txt` sealed by **filippo.io/age** — the Go reference implementation, https://github.com/FiloSottile/age. |
| `port.age` | `plaintext.txt` sealed by **this repo's** `sealToRecipients` (`server/src/crypto/keys.ts`), then decrypted by the reference to prove it opens. |
| `manifest.json` | Provenance: implementation and version for each side, the exact command, the UTC timestamp, and the SHA-256 of both ciphertexts. The test asserts those digests, so a fixture regenerated from this port alone cannot pass as interop evidence. |
| `regenerate.ts` | The one-off generator. Refuses to run without the reference CLI, and refuses to write anything unless both directions decrypt. |

All files are armoured (`-----BEGIN AGE ENCRYPTED FILE-----`), because that is the
form `letters.body` stores (see the header of `server/src/crypto/keys.ts` for the
armouring boundary in full).

## Provenance of the committed pair

Generated 2026-11-07T20:39:50Z (2026-11-08, 00:39 +04) by

```
npx tsx server/test/fixtures/age/regenerate.ts
```

with `age` v1.3.2 (filippo.io/age, BSD-3-Clause, Homebrew bottle) and
`age-encryption` 0.3.1. The script verifies both directions before writing:
this port opened `reference.age`, and `age -d -i identity.txt port.age` returned
`plaintext.txt` byte for byte. The reported digests are in `manifest.json`.

## Regenerating

```
brew install age            # or: go install filippo.io/age/cmd/age@latest
npx tsx server/test/fixtures/age/regenerate.ts
```

Regeneration rewrites both ciphertexts (age is randomised) and the manifest, so
review the diff: a fixture whose `reference.version` is not a real filippo.io/age
release, or whose `reference.command` mentions this port, is not interop
evidence.

## Why both directions, and which runs where

- **Reference → this port** (`reference.age`) runs in CI on every test run. It is
  the assertion that catches a `age-encryption` upgrade that changes header or
  stanza parsing: the bytes are frozen, so if the new build cannot read them,
  every letter already in the database is unreadable too.
- **This port → reference** cannot rely on CI: the workflow (`.github/workflows/ci.yml`)
  installs no `age` binary, so the reference checks skip there. Two things cover it
  instead: the committed `port.age`, which the reference decrypted at generation time and
  which this port must still decrypt (so output-format drift across a version bump fails
  the suite); and a live check that runs `age -d` against both the frozen fixture and a
  freshly sealed ciphertext **when `age` is on `PATH`**, and skips with a visible notice
  when it is not. A skip there is not a pass — read the run output. If a future runner
  image does ship `age`, those two checks simply start running in CI.
