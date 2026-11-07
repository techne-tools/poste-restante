/**
 * The identity-key protocol — SPEC §19, hermetic unit tests.
 *
 * The load-bearing property: the letter id hashes the IDENTITY, not the
 * handle — so a rename never changes a letter's id. The canonical form
 * resolves handles → identity ids (the ed25519 public key fingerprint)
 * before hashing.
 */
import { describe, it, expect } from "vitest";
import {
  canonicaliseWith,
  letterIdFromCanonical,
  canonicaliseLegacy,
  resolvePinnedId,
  resolveSignedId,
} from "../../src/id.js";
import { generateEd25519Keypair, signLetterId, verifyLetterId } from "../../src/crypto/keys.js";
import type { Letter, SealedLetterBody } from "../../src/types.js";

const mkLetter = (over: Record<string, unknown> = {}): Letter => ({
  envelope: {
    from: "ben@house",
    to: ["you@house"],
    cc: [],
    thread: "th_identity_1",
    kind: "letter",
    lang: "en-AU",
    subject: "the tempest",
  },
  time: { gregorian: "2026-09-10T10:00:00Z", frames: [] },
  body: { format: "markdown", content: "the storm is coming" },
  ...over,
});

describe("the load-bearing property — a rename never changes the id", () => {
  it("the same identity under a different handle hashes identically", () => {
    const benKey = "MCowBQYDK2VwAyEA-ben-public-key";
    const letterAsBen = mkLetter();
    const letterAsSam = mkLetter({ envelope: { ...mkLetter().envelope, from: "sam@house" } });

    // ben and sam are the SAME identity (same key) — the canonical form
    // resolves both to the key, so the ids match.
    const identities = new Map([
      ["ben@house", benKey],
      ["sam@house", benKey],
    ]);
    const idBen = letterIdFromCanonical(canonicaliseWith(letterAsBen, identities));
    const idSam = letterIdFromCanonical(canonicaliseWith(letterAsSam, identities));
    expect(idBen).toBe(idSam);
  });

  it("a different identity hashes differently", () => {
    const identities = new Map([
      ["ben@house", "key-ben"],
      ["sam@house", "key-sam"],
    ]);
    const idBen = letterIdFromCanonical(canonicaliseWith(mkLetter(), identities));
    const idSam = letterIdFromCanonical(
      canonicaliseWith(
        mkLetter({ envelope: { ...mkLetter().envelope, from: "sam@house" } }),
        identities,
      ),
    );
    expect(idBen).not.toBe(idSam);
  });

  it("legacy addresses without keys resolve to themselves — the identity IS the handle", () => {
    const id = letterIdFromCanonical(canonicaliseWith(mkLetter(), new Map()));
    const legacy = letterIdFromCanonical(canonicaliseLegacy(mkLetter()));
    expect(id).toBe(legacy);
  });

  it("the canonical form is deterministic — same letter, same id", () => {
    const identities = new Map([["ben@house", "key-ben"]]);
    const a = letterIdFromCanonical(canonicaliseWith(mkLetter(), identities));
    const b = letterIdFromCanonical(canonicaliseWith(mkLetter(), identities));
    expect(a).toBe(b);
  });
});

/* ── The pin — the identity is durable, the key is material ──────────────
 * SPEC §19, amended 2026-11-08. The id resolves handles to the address's
 * durable identity, so a rotation cannot move it; what a rotation does move is
 * which generation of the sender's key made the signature. Two rules therefore
 * live side by side, and these tests pin down the distinction. */

const CIPHERTEXT = "-----BEGIN AGE ENCRYPTED FILE-----\nnot really\n-----END AGE ENCRYPTED FILE-----";

type SealedLetter = Letter & { body: SealedLetterBody };

const mkSealed = (from: string, to: string[]): SealedLetter => ({
  envelope: { from, to, cc: [], thread: "th_pin", kind: "letter", lang: "en-AU", subject: "" },
  time: { gregorian: "2026-11-08T10:00:00Z", frames: [] },
  body: { format: "sealed", content: CIPHERTEXT, recipients: [], signature: "" },
});

const idOf = (letter: Letter, identities: Map<string, string>) =>
  letterIdFromCanonical(canonicaliseWith(letter, identities));

describe("the pin — a rotation moves the key, never the id", () => {
  // ben's identity is the key it registered FIRST; the key ben holds now is a
  // later, unrelated generation.
  const pinnedIdentity = "ben-first-key-fingerprint";
  const retiredKey = generateEd25519Keypair();
  const liveKey = generateEd25519Keypair();
  const pinned = new Map([
    ["ben@house", pinnedIdentity],
    ["you@house", "you-identity"],
  ]);
  const live = new Map([
    ["ben@house", liveKey.publicKey],
    ["you@house", "you-identity"],
  ]);

  it("keys the letter on the identity and verifies it under the LIVE key", () => {
    // A pinned client hashes the identity and signs with the key it holds now.
    const letter = mkSealed("ben@house", ["you@house"]);
    const signedId = idOf(letter, pinned);
    letter.body.signature = signLetterId(signedId, liveKey.privateKey);

    // The identity did not move, so the id did not move either — and the
    // signature is checked against every generation ben has held.
    expect(
      resolvePinnedId(
        letter,
        pinned,
        [liveKey.publicKey, retiredKey.publicKey],
        letter.body.signature,
        verifyLetterId,
      ),
    ).toBe(signedId);
    expect(signedId).toBe(idOf(mkSealed("ben@house", ["you@house"]), pinned));
  });

  it("does NOT accept that letter under the pre-pin rule — the two ids differ", () => {
    const letter = mkSealed("ben@house", ["you@house"]);
    const signedId = idOf(letter, pinned);
    letter.body.signature = signLetterId(signedId, liveKey.privateKey);

    // resolveSignedId re-derives the id per generation, and none of those ids
    // is the one signed (the signature covers the identity's id, not the key's).
    expect(
      resolveSignedId(
        letter,
        live,
        [liveKey.publicKey, retiredKey.publicKey],
        letter.body.signature,
        verifyLetterId,
      ),
    ).toBeNull();
  });

  it("still recovers a pre-pin letter sealed over the LIVE keys", () => {
    // What a client that predates the `identityId` field computes: the live
    // key for every handle. It signs the id that map produces.
    const letter = mkSealed("ben@house", ["you@house"]);
    const legacyId = idOf(letter, live);
    letter.body.signature = signLetterId(legacyId, liveKey.privateKey);

    // The pinned rule cannot see it...
    expect(
      resolvePinnedId(
        letter,
        pinned,
        [liveKey.publicKey, retiredKey.publicKey],
        letter.body.signature,
        verifyLetterId,
      ),
    ).toBeNull();
    // ...the legacy rule recovers it, exactly.
    expect(
      resolveSignedId(
        letter,
        live,
        [liveKey.publicKey, retiredKey.publicKey],
        letter.body.signature,
        verifyLetterId,
      ),
    ).toBe(legacyId);
    expect(legacyId).not.toBe(idOf(letter, pinned));
  });

  it("accepts no key the sender never held, under either rule", () => {
    const letter = mkSealed("ben@house", ["you@house"]);
    const signedId = idOf(letter, pinned);
    letter.body.signature = signLetterId(signedId, generateEd25519Keypair().privateKey);

    expect(
      resolvePinnedId(letter, pinned, [liveKey.publicKey], letter.body.signature, verifyLetterId),
    ).toBeNull();
    expect(
      resolveSignedId(letter, live, [liveKey.publicKey], letter.body.signature, verifyLetterId),
    ).toBeNull();
  });
});
