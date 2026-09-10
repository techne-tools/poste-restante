/**
 * The identity-key protocol — SPEC §19, hermetic unit tests.
 *
 * The load-bearing property: the letter id hashes the IDENTITY, not the
 * handle — so a rename never changes a letter's id. The canonical form
 * resolves handles → identity ids (the ed25519 public key fingerprint)
 * before hashing.
 */
import { describe, it, expect } from "vitest";
import { canonicaliseWith, letterIdFromCanonical, canonicaliseLegacy } from "../../src/id.js";
import type { Letter } from "../../src/types.js";

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
