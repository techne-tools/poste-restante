import { describe, it, expect } from "vitest";
import { letterIdFromCanonical, canonicaliseWith, canonicaliseLegacy } from "../../src/id.js";
import type { Letter } from "../../src/types.js";

const base: Letter = {
  id: "",
  envelope: {
    from: "hermes@house",
    to: ["you@house"],
    cc: [],
    thread: "th_9f2c1",
    kind: "letter",
    lang: "en-AU",
    subject: "re: the plural-time archive",
  },
  time: {
    gregorian: "2026-08-29T14:00:00+04:00",
    frames: [
      { frame: "islamic", value: "1448-03-15" },
      { frame: "season", value: "autumn" },
    ],
  },
  body: { format: "markdown", content: "## The archive, in practice\n\n..." },
};

const noKeys = new Map<string, string>();

describe("letterIdFromCanonical", () => {
  it("is a 64-char sha256 hex", () => {
    const id = letterIdFromCanonical(canonicaliseWith(base, noKeys));
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls", () => {
    expect(letterIdFromCanonical(canonicaliseWith(base, noKeys))).toBe(
      letterIdFromCanonical(canonicaliseWith(base, noKeys)),
    );
  });

  it("changes when the body changes", () => {
    const changed = { ...base, body: { ...base.body, content: "different" } };
    expect(letterIdFromCanonical(canonicaliseWith(changed, noKeys))).not.toBe(
      letterIdFromCanonical(canonicaliseWith(base, noKeys)),
    );
  });

  it("changes when the envelope changes", () => {
    const changed = {
      ...base,
      envelope: { ...base.envelope, subject: "a new subject" },
    };
    expect(letterIdFromCanonical(canonicaliseWith(changed, noKeys))).not.toBe(
      letterIdFromCanonical(canonicaliseWith(base, noKeys)),
    );
  });

  it("is order-independent over frames", () => {
    const a = {
      ...base,
      time: {
        ...base.time,
        frames: [
          { frame: "islamic", value: "1448-03-15" },
          { frame: "season", value: "autumn" },
        ],
      },
    };
    const b = {
      ...base,
      time: {
        ...base.time,
        frames: [
          { frame: "season", value: "autumn" },
          { frame: "islamic", value: "1448-03-15" },
        ],
      },
    };
    expect(letterIdFromCanonical(canonicaliseWith(a, noKeys))).toBe(
      letterIdFromCanonical(canonicaliseWith(b, noKeys)),
    );
  });
});

describe("canonicaliseWith", () => {
  it("produces a stable serialisation", () => {
    expect(canonicaliseWith(base, noKeys)).toBe(canonicaliseWith(base, noKeys));
  });

  it("legacy form matches the no-key resolution — the identity IS the handle", () => {
    expect(canonicaliseWith(base, noKeys)).toBe(canonicaliseLegacy(base));
  });
});
