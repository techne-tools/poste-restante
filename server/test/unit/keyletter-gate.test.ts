/**
 * The keyletter gate — what the house will and will not accept (SPEC §15).
 *
 * Three layers are proven here, each the one that owns the decision:
 *
 *   the SCHEMA   a key frame's keys must be material a letter can be sealed
 *                to and an id can hash; malformed halves never reach the
 *                pipeline (the same rule registration follows).
 *
 *   the PIPELINE the kind and the body must name the same thing, the
 *                signature must verify over the id the body hashes to, and the
 *                three refusals are distinguished — unsigned, bad signature,
 *                kind/body mismatch — so the door can answer truthfully.
 *
 *   the DOOR     each refusal becomes one code and one sentence
 *                (`rejectionAnswer`), which is what a caller actually sees.
 *
 * Hermetic: no postgres. The integration suite proves the same behaviour
 * against the real schema, and the round trip that makes a keyless
 * correspondent reachable.
 */
import { describe, it, expect } from "vitest";
import { LetterSchema, keyFrameBodyFromStored, toLetter } from "../../src/schemas.js";
import { rejectionAnswer } from "../../src/deliver.js";
import { IngestionPipeline } from "../../src/pipeline/pipeline.js";
import { generateResidentKeypair, signLetterId } from "../../src/crypto/keys.js";
import { canonicaliseWith, letterIdFromCanonical } from "../../src/id.js";
import type { KeyFrameBody, Letter, StoredLetter } from "../../src/types.js";
import type { StoredLetterRow } from "../../src/db/repository.js";

const noopLog = { info: () => {}, warn: () => {}, error: () => {} };

function fakePipeline(opts: { liveKeys?: Map<string, string> } = {}) {
  const stored: StoredLetter[] = [];
  const keyWrites: unknown[][] = [];
  const repo = {
    getLetter: async () => null,
    storeLetter: async (letter: StoredLetter) => {
      stored.push(letter);
    },
    getIdentityIds: async (addresses: string[]) =>
      new Map(addresses.filter((a) => opts.liveKeys?.has(a)).map((a) => [a, opts.liveKeys!.get(a)!])),
    getAddressKeys: async () => new Map<string, string>(),
    getAddressKeyHistory: async () => [],
    getAddressKey: async () => null,
    setAddressKey: async (...args: unknown[]) => {
      keyWrites.push(args);
    },
    saveKeyOffer: async () => {},
    resolveKeyOffer: async () => {},
  };
  const pipeline = new IngestionPipeline(
    repo as never,
    { upsert: async () => {}, delete: async () => {} } as never,
    { embed: async () => [0.1] } as never,
    undefined,
    noopLog as never,
  );
  return { pipeline, stored, keyWrites };
}

function frameLetter(
  frame: KeyFrameBody["keys"],
  opts: { kind?: string; signature?: string; signingKey?: string; content?: string } = {},
): { letter: Letter & { body: KeyFrameBody }; id: string } {
  const letter: Letter & { body: KeyFrameBody } = {
    envelope: {
      from: "corr@house",
      to: ["you@house"],
      cc: [],
      thread: "th_key",
      // Deliberately overridable: the kind/body mismatch is a case under test.
      kind: (opts.kind ?? "keyletter") as Letter["envelope"]["kind"],
      lang: "en-AU",
      subject: "my keys",
    },
    time: { gregorian: "2026-11-08T12:00:00.000Z", frames: [] },
    body: {
      format: "keyframe",
      keys: frame,
      content: opts.content ?? "These are my keys — seal to me.",
      signature: opts.signature ?? "",
    },
  };
  const id = letterIdFromCanonical(canonicaliseWith(letter, new Map()));
  if (opts.signingKey) {
    letter.body = { ...letter.body, signature: signLetterId(id, opts.signingKey) };
  }
  return { letter, id };
}

describe("the key frame schema", () => {
  it("accepts a well-formed frame travelling as a keyletter", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const { letter } = frameLetter(keys.public);
    expect(LetterSchema.safeParse(letter).success).toBe(true);
  });

  it("refuses halves no letter could be sealed to or hashed against", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const badRecipient = frameLetter({ ...keys.public, ageRecipient: "not-an-age-recipient" });
    const badKey = frameLetter({ ...keys.public, ed25519Public: "AAAA" });
    expect(LetterSchema.safeParse(badRecipient.letter).success).toBe(false);
    expect(LetterSchema.safeParse(badKey.letter).success).toBe(false);
  });

  it("does not require a signature — an unsigned frame reaches the pipeline and is answered there", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const { letter } = frameLetter(keys.public);
    // The schema's job is shape. Whether a frame is signed is a fact the
    // pipeline can name precisely, so it is not flattened into "invalid".
    expect(LetterSchema.safeParse(letter).success).toBe(true);
  });
});

describe("the pipeline's keyletter gate", () => {
  it("stores a signed keyletter and installs its keys", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const { letter, id } = frameLetter(keys.public, { signingKey: keys.ed25519Private });
    const { pipeline, stored, keyWrites } = fakePipeline();

    const result = await pipeline.ingest(letter);
    expect(result).toEqual({ letterId: id, created: true });
    expect(stored).toHaveLength(1);
    // Stored first (the letter exists), then applied — the order the offer's
    // foreign key requires.
    expect(keyWrites).toEqual([["corr@house", keys.public, "keyletter", id]]);
  });

  it("refuses an unsigned frame, and says which silence it is", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const { letter, id } = frameLetter(keys.public);
    const { pipeline, stored, keyWrites } = fakePipeline();

    const result = await pipeline.ingest(letter);
    expect(result).toEqual({
      letterId: id,
      created: false,
      rejected: true,
      rejectionReason: "unsigned",
    });
    // Nothing stored, nothing installed: the house does not keep what it
    // cannot verify.
    expect(stored).toHaveLength(0);
    expect(keyWrites).toHaveLength(0);
  });

  it("refuses a frame whose signature does not verify under the key it publishes", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const impostor = await generateResidentKeypair("other@house");
    const { letter, id } = frameLetter(keys.public, { signingKey: impostor.ed25519Private });
    const { pipeline, stored } = fakePipeline();

    const result = await pipeline.ingest(letter);
    expect(result).toEqual({
      letterId: id,
      created: false,
      rejected: true,
      rejectionReason: "bad_signature",
    });
    expect(stored).toHaveLength(0);
  });

  it("refuses a key frame travelling as an ordinary letter, and a keyletter that is prose", async () => {
    const keys = await generateResidentKeypair("corr@house");
    const disguised = frameLetter(keys.public, {
      kind: "letter",
      signingKey: keys.ed25519Private,
    });
    const prose: Letter = {
      envelope: {
        from: "corr@house",
        to: ["you@house"],
        cc: [],
        thread: "th_key",
        kind: "keyletter",
        lang: "en-AU",
        subject: "my keys",
      },
      time: { gregorian: "2026-11-08T12:00:00.000Z", frames: [] },
      body: { format: "markdown", content: "these are my keys, honest" },
    };
    const { pipeline, stored, keyWrites } = fakePipeline();

    // A key frame must not install anything while pretending to be a letter…
    const first = await pipeline.ingest(disguised.letter);
    expect(first.rejected).toBe(true);
    expect(first.rejectionReason).toBe("frame_mismatch");
    // …and a keyletter whose body is prose is not a keyletter.
    const second = await pipeline.ingest(prose);
    expect(second.rejected).toBe(true);
    expect(second.rejectionReason).toBe("frame_mismatch");
    expect(stored).toHaveLength(0);
    expect(keyWrites).toHaveLength(0);
  });
});

describe("the door's answer", () => {
  it("maps each silence to its own code and sentence", () => {
    expect(rejectionAnswer("unsigned")).toEqual({
      status: 400,
      code: "keyletter_unsigned",
      message: "a keyletter must carry a signature over its own id — this one carries none",
    });
    expect(rejectionAnswer("frame_mismatch").code).toBe("invalid_letter");
    expect(rejectionAnswer("bad_signature").code).toBe("invalid_signature");
    // A sealed letter's rejection carries no reason at all, and still answers
    // the honest one: the house cannot say which silence it is.
    expect(rejectionAnswer(undefined).code).toBe("invalid_signature");
  });
});

describe("reading a stored keyletter back", () => {
  it("serves the frame the letter carried, keys and signature included", () => {
    const row = {
      id: "abc",
      from_addr: "corr@house",
      to_addrs: ["you@house"],
      cc_addrs: [],
      thread_id: "th_key",
      kind: "keyletter",
      lang: "en-AU",
      subject: "my keys",
      body: JSON.stringify({
        format: "keyframe",
        content: "These are my keys.",
        keys: { ageRecipient: "age1x", ed25519Public: "edx", recoveryAgeRecipient: null },
        signature: "sig",
      }),
      received_at: new Date("2026-11-08T12:00:00.000Z"),
      pinned_at: null,
      pinned_by: null,
      sealed: false,
      signature: null,
      frames: [],
    } as unknown as StoredLetterRow;

    const letter = toLetter(row);
    expect(letter.body.format).toBe("keyframe");
    const body = letter.body as KeyFrameBody;
    expect(body.keys.ed25519Public).toBe("edx");
    expect(body.signature).toBe("sig");
  });

  it("falls back to plain text rather than inventing a frame it cannot read", () => {
    // A row that claims the kind but carries something else is served as what
    // it is. Nothing is guessed, and nothing throws on a read path.
    expect(keyFrameBodyFromStored("not json at all")).toBeNull();
    expect(keyFrameBodyFromStored(JSON.stringify({ format: "markdown", content: "x" }))).toBeNull();
  });
});
