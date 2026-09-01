/**
 * Horizon View logic — unit tests. The intersection semantics are the whole
 * point: two selected frames foreground the letters in BOTH (∩), shows the
 * partially-matched as mid-dim, and dims the rest.
 */
import { describe, it, expect } from "vitest";
import {
  classifyLetter,
  letterInFrame,
  railPositions,
  byTimeAsc,
  byTimeDesc,
  threadsWithMultipleAccounts,
} from "./frameUtils";
import type { Letter } from "./api";

function letter(id: string, frames: { frame: string; value: string }[], receivedAt: string): Letter {
  return {
    id,
    envelope: {
      from: "a@house",
      to: ["b@house"],
      cc: [],
      thread: "th_1",
      kind: "letter",
      lang: "en-AU",
      subject: `subject ${id}`,
    },
    time: { gregorian: receivedAt, frames },
    body: { format: "markdown", content: "" },
    receivedAt,
    pinnedAt: null,
    pinnedBy: null,
  };
}

describe("letterInFrame", () => {
  it("matches a frame by name and value", () => {
    const l = letter("1", [{ frame: "production", value: "tempest-2026" }], "2026-08-01");
    expect(letterInFrame(l, "production", "tempest-2026")).toBe(true);
    expect(letterInFrame(l, "season", "autumn")).toBe(false);
  });
});

describe("classifyLetter — the ∩", () => {
  const lBoth = letter("both", [
    { frame: "production", value: "tempest-2026" },
    { frame: "season", value: "autumn" },
  ], "2026-08-01");
  const lProdOnly = letter("prod", [{ frame: "production", value: "tempest-2026" }], "2026-08-02");
  const lNone = letter("none", [], "2026-08-03");

  it("nothing selected → every letter is none (nothing dims)", () => {
    expect(classifyLetter(lBoth, new Set())).toBe("none");
    expect(classifyLetter(lNone, new Set())).toBe("none");
  });

  it("one frame selected → in it is full, outside is dim", () => {
    const active = new Set(["production:tempest-2026"]);
    expect(classifyLetter(lBoth, active)).toBe("full");
    expect(classifyLetter(lProdOnly, active)).toBe("full");
    expect(classifyLetter(lNone, active)).toBe("dim");
  });

  it("two frames selected → intersection is full, one-of is partial, none is dim", () => {
    const active = new Set(["production:tempest-2026", "season:autumn"]);
    expect(classifyLetter(lBoth, active)).toBe("full"); // the ∩
    expect(classifyLetter(lProdOnly, active)).toBe("partial");
    expect(classifyLetter(lNone, active)).toBe("dim");
  });

  it("the intersection shrinks as frames accumulate — ∩ is AND, not OR", () => {
    const active = new Set(["production:tempest-2026", "season:autumn", "semester:autumn-2026"]);
    expect(classifyLetter(lBoth, active)).toBe("partial"); // no longer full
    expect(classifyLetter(lProdOnly, active)).toBe("partial");
  });
});

describe("railPositions — the transit ticks", () => {
  it("maps each frame to the flow indexes of its letters", () => {
    const letters = [
      letter("a", [{ frame: "season", value: "autumn" }], "2026-08-03"),
      letter("b", [{ frame: "production", value: "tempest-2026" }], "2026-08-02"),
      letter("c", [
        { frame: "season", value: "autumn" },
        { frame: "production", value: "tempest-2026" },
      ], "2026-08-01"),
    ];
    const frames = [
      { id: "season:autumn", name: "season", value: "autumn" },
      { id: "production:tempest-2026", name: "production", value: "tempest-2026" },
    ];
    const pos = railPositions(letters, frames);
    expect(pos.get("season:autumn")).toEqual([0, 2]); // a + c
    expect(pos.get("production:tempest-2026")).toEqual([1, 2]); // b + c
  });
});

describe("byTimeDesc", () => {
  it("sorts newest first — the whisper and search feed order", () => {
    const older = letter("old", [], "2026-08-01T00:00:00Z");
    const newer = letter("new", [], "2026-08-05T00:00:00Z");
    expect([older, newer].sort(byTimeDesc)).toEqual([newer, older]);
  });
});

describe("byTimeAsc", () => {
  it("sorts oldest first — the timeline axis when browsing the archive", () => {
    const older = letter("old", [], "2026-08-01T00:00:00Z");
    const newer = letter("new", [], "2026-08-05T00:00:00Z");
    expect([newer, older].sort(byTimeAsc)).toEqual([older, newer]);
  });

  it("is the exact inverse of byTimeDesc", () => {
    const letters = [
      letter("a", [], "2026-08-01T00:00:00Z"),
      letter("b", [], "2026-08-03T00:00:00Z"),
      letter("c", [], "2026-08-02T00:00:00Z"),
    ];
    expect(letters.sort(byTimeAsc).map((l) => l.id)).toEqual(["a", "c", "b"]);
    expect(letters.sort(byTimeDesc).map((l) => l.id)).toEqual(["b", "c", "a"]);
  });
});

describe("threadsWithMultipleAccounts — the contradiction surface", () => {
  const l = (id: string, thread: string, frames: { frame: string; value: string }[]) =>
    ({ ...letter(id, frames, "2026-08-01"), envelope: { ...letter(id, frames, "2026-08-01").envelope, thread } });

  it("flags a thread that has 2+ letters in a frame — the reader may be told, not told which is right", () => {
    const letters = [
      l("a", "th_x", [{ frame: "production", value: "tempest-2026" }]),
      l("b", "th_x", [{ frame: "production", value: "tempest-2026" }]),
      l("c", "th_y", [{ frame: "production", value: "tempest-2026" }]),
    ];
    const flagged = threadsWithMultipleAccounts(letters, "production:tempest-2026");
    expect([...flagged]).toEqual(["th_x"]); // th_y has only one account here
  });

  it("leaves a frame empty of contradictions when threads hold a single account each", () => {
    const letters = [
      l("a", "th_1", [{ frame: "production", value: "tempest-2026" }]),
      l("b", "th_2", [{ frame: "production", value: "tempest-2026" }]),
    ];
    expect(threadsWithMultipleAccounts(letters, "production:tempest-2026").size).toBe(0);
  });

  it("ignores letters outside the frame — a thread's accounts in another frame don't count", () => {
    const letters = [
      l("a", "th_x", [{ frame: "production", value: "tempest-2026" }]),
      l("b", "th_x", [{ frame: "season", value: "autumn" }]), // same thread, other frame
    ];
    expect(threadsWithMultipleAccounts(letters, "production:tempest-2026").size).toBe(0);
  });
});
