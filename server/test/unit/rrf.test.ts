import { describe, it, expect } from "vitest";
import { rrf } from "../../src/retrieval/retrieval.js";

describe("rrf", () => {
  it("fuses ranked lists by reciprocal rank", () => {
    const fused = rrf([
      { path: "exact", ids: ["a", "b", "c"] },
      { path: "fulltext", ids: ["b", "a", "d"] },
    ]);
    // a: 1/61 + 1/62 ; b: 1/62 + 1/61 ; c: 1/63 ; d: 1/63
    const a = fused.get("a")!;
    const b = fused.get("b")!;
    expect(a.score).toBeCloseTo(1 / 61 + 1 / 62);
    expect(b.score).toBeCloseTo(1 / 62 + 1 / 61);
    // a and b appear in both paths; c and d in one.
    expect(a.paths).toEqual(["exact", "fulltext"]);
    expect(fused.get("c")!.paths).toEqual(["exact"]);
    expect(fused.get("d")!.paths).toEqual(["fulltext"]);
  });

  it("ranks a letter in both paths above one in a single path", () => {
    const fused = rrf([
      { path: "exact", ids: ["a", "b"] },
      { path: "fulltext", ids: ["a"] },
    ]);
    expect(fused.get("a")!.score).toBeGreaterThan(fused.get("b")!.score);
  });

  it("is order-sensitive: higher rank contributes more", () => {
    const fused = rrf([
      { path: "exact", ids: ["a", "b"] },
      { path: "fulltext", ids: ["b", "a"] },
    ]);
    // a: 1/61 + 1/62 ; b: 1/62 + 1/61 — equal.
    expect(fused.get("a")!.score).toBeCloseTo(fused.get("b")!.score);
  });

  it("handles empty lists", () => {
    const fused = rrf([]);
    expect(fused.size).toBe(0);
  });
});
