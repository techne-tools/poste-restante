/**
 * The keyletter — a letter that carries a public key (SPEC §15, migration 034).
 *
 * Two things are tested here, and they are different questions:
 *
 *   VERIFICATION  does the frame prove what it claims? The signature must be
 *                 over the letter id and made with the private half of the key
 *                 the frame publishes — nothing else counts, and the two ways
 *                 of failing are told apart (unsigned vs a signature that does
 *                 not verify).
 *
 *   APPLICATION   what the house does with a verified frame: install on first
 *                 sight (TOFU), no-op when the record already agrees, OFFER
 *                 when it disagrees. Never a silent overwrite — whoever sealed
 *                 to the old key needs to see the change.
 *
 * Hermetic: a fake repository, no postgres. The integration suite proves the
 * same behaviour against the real schema.
 */
import { describe, it, expect } from "vitest";
import { applyKeyFrame, verifyKeyFrame } from "../../src/keyletter.js";
import { generateResidentKeypair, signLetterId } from "../../src/crypto/keys.js";
import { canonicaliseWith, letterIdFromCanonical } from "../../src/id.js";
import type { KeyFrameBody, Letter } from "../../src/types.js";
import type { PostgresRepository } from "../../src/db/repository.js";

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

type Keyset = { ageRecipient: string; ed25519Public: string; recoveryAgeRecipient: string | null };

/** A key frame letter, signed over the id it resolves to under `identities`
 *  with the private half of `signingKey` — which may deliberately be the WRONG
 *  key, because that is the case under test. */
function keyLetter(
  frame: Keyset,
  opts: {
    from?: string;
    to?: string[];
    note?: string;
    identities?: Map<string, string>;
    signingKey?: string;
    signature?: string;
  } = {},
): { letter: Letter & { body: KeyFrameBody }; id: string } {
  const letter: Letter & { body: KeyFrameBody } = {
    envelope: {
      from: opts.from ?? "corr@house",
      to: opts.to ?? ["you@house"],
      cc: [],
      thread: "th_key",
      kind: "keyletter",
      lang: "en-AU",
      subject: "my keys",
    },
    time: { gregorian: "2026-11-08T12:00:00.000Z", frames: [] },
    body: {
      format: "keyframe",
      keys: frame,
      content: opts.note ?? "These are my keys — seal to me.",
      signature: "",
    },
  };
  const identities = opts.identities ?? new Map<string, string>();
  const id = letterIdFromCanonical(canonicaliseWith(letter, identities));
  if (opts.signature !== undefined) {
    letter.body.signature = opts.signature;
  } else if (opts.signingKey) {
    letter.body.signature = signLetterId(id, opts.signingKey);
  }
  return { letter, id };
}

function fakeRepo(live: Keyset | null) {
  const calls: { method: string; args: unknown[] }[] = [];
  const repo = {
    // The shape `getAddressKey` really returns: the row's columns, snake_case.
    getAddressKey: async () =>
      live === null
        ? null
        : {
            age_recipient: live.ageRecipient,
            ed25519_public: live.ed25519Public,
            recovery_age_recipient: live.recoveryAgeRecipient,
          },
    setAddressKey: async (...args: unknown[]) => {
      calls.push({ method: "setAddressKey", args });
    },
    saveKeyOffer: async (...args: unknown[]) => {
      calls.push({ method: "saveKeyOffer", args });
    },
    resolveKeyOffer: async (...args: unknown[]) => {
      calls.push({ method: "resolveKeyOffer", args });
    },
  };
  return { repo: repo as unknown as PostgresRepository, calls };
}

describe("a key frame's signature", () => {
  it("verifies when it was made with the key the frame publishes", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const { letter, id } = keyLetter(keys.public, { signingKey: keys.ed25519Private });
    expect(verifyKeyFrame(id, letter.body)).toEqual({ ok: true });
  });

  it("is refused as unsigned — not as a bad signature — when it carries none", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const { letter, id } = keyLetter(keys.public);
    // Two different silences, and the house says which: nothing was signed at
    // all, which is not the same fact as a signature that does not hold.
    expect(verifyKeyFrame(id, letter.body)).toEqual({ ok: false, reason: "unsigned" });
  });

  it("is refused when another key made it", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const impostor = await generateResidentKeypair("other@house");
    // The frame publishes `keys`, but the signature was made by somebody
    // else's private half: possession of the published key is not shown.
    const { letter, id } = keyLetter(keys.public, { signingKey: impostor.ed25519Private });
    expect(verifyKeyFrame(id, letter.body)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("covers the keys: swapping the key material breaks a valid signature", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const other = await generateResidentKeypair("corr@house");
    const { letter, id } = keyLetter(keys.public, { signingKey: keys.ed25519Private });

    // The id hashes the frame INCLUDING its keys — otherwise a signature would
    // say nothing about the material it was attached to, and anyone could swap
    // the key under a valid signature.
    const swapped: KeyFrameBody = { ...letter.body, keys: other.public };
    expect(letterIdFromCanonical(canonicaliseWith({ ...letter, body: swapped }, new Map()))).not.toBe(id);
    expect(verifyKeyFrame(id, swapped)).toEqual({ ok: false, reason: "bad_signature" });
  });

  it("covers the note too: a rewritten body hashes to an id the signature does not name", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const { letter, id } = keyLetter(keys.public, { signingKey: keys.ed25519Private });
    const rewritten: KeyFrameBody = { ...letter.body, content: "these are somebody else's keys" };

    // The pipeline derives the id from the body it RECEIVED, then verifies the
    // signature against that id. So a rewritten note is a different letter, and
    // the signature — which names the original id — verifies under neither.
    const rewrittenId = letterIdFromCanonical(
      canonicaliseWith({ ...letter, body: rewritten }, new Map()),
    );
    expect(rewrittenId).not.toBe(id);
    expect(verifyKeyFrame(rewrittenId, rewritten)).toEqual({ ok: false, reason: "bad_signature" });
  });
});

describe("applying a verified key frame", () => {
  it("installs on first sight, with origin keyletter and the letter's id", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const { letter, id } = keyLetter(keys.public, { signingKey: keys.ed25519Private });
    const { repo, calls } = fakeRepo(null);

    expect(await applyKeyFrame(repo, noopLog as never, letter, id)).toBe("installed");
    expect(calls).toEqual([
      {
        method: "setAddressKey",
        args: ["corr@house", keys.public, "keyletter", id],
      },
    ]);
  });

  it("does nothing when the live record already says the same thing", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const { letter, id } = keyLetter(keys.public, { signingKey: keys.ed25519Private });
    const { repo, calls } = fakeRepo(keys.public);

    expect(await applyKeyFrame(repo, noopLog as never, letter, id)).toBe("unchanged");
    // No key is written, and a pending offer for these keys is settled: the
    // record already agrees, so there is no question left to hold open.
    expect(calls).toEqual([{ method: "resolveKeyOffer", args: ["corr@house", "accepted"] }]);
  });

  it("raises an offer — never an overwrite — when the live record differs", async () => {
    const old = await generateResidentKeypair("corr@house");
    const keys = await generateResidentKeypair("corr@house");
    const { letter, id } = keyLetter(keys.public, { signingKey: keys.ed25519Private });
    const { repo, calls } = fakeRepo(old.public);

    expect(await applyKeyFrame(repo, noopLog as never, letter, id)).toBe("offered");
    expect(calls).toEqual([
      {
        method: "saveKeyOffer",
        args: ["corr@house", id, keys.public],
      },
    ]);
    // The live key is what letters were sealed to; it is not touched.
    expect(calls.some((c) => c.method === "setAddressKey")).toBe(false);
  });

  it("treats a recovery recipient alone differing as a difference", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const recovery = await generateResidentKeypair("corr@house");
    const frame = { ...keys.public, recoveryAgeRecipient: recovery.public.ageRecipient };
    const { letter, id } = keyLetter(frame, { signingKey: keys.ed25519Private });
    const { repo } = fakeRepo(keys.public);

    expect(await applyKeyFrame(repo, noopLog as never, letter, id)).toBe("offered");
  });
});
