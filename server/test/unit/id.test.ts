import { describe, it, expect } from "vitest";
import { letterId, canonicalise } from "../../src/id.js";
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

describe("letterId", () => {
  it("is a 64-char sha256 hex", () => {
    const id = letterId(base);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
  });

  it("is stable across calls", () => {
    expect(letterId(base)).toBe(letterId(base));
  });

  it("changes when the body changes", () => {
    const changed = { ...base, body: { ...base.body, content: "different" } };
    expect(letterId(changed)).not.toBe(letterId(base));
  });

  it("changes when the envelope changes", () => {
    const changed = {
      ...base,
      envelope: { ...base.envelope, subject: "a new subject" },
    };
    expect(letterId(changed)).not.toBe(letterId(base));
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
    expect(letterId(a)).toBe(letterId(b));
  });
});

describe("canonicalise", () => {
  it("produces a stable serialisation", () => {
    expect(canonicalise(base)).toBe(canonicalise(base));
  });
});
