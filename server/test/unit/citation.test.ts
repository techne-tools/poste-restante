/**
 * The whisper's citation of the book — pure derivation tests.
 *
 * pickCitation is the deterministic heart of the citation pass: given the
 * semantic hits for a whisper's own summary and the standing clauses,
 * return the best standing clause above the threshold, or null. Only
 * STANDING clauses are citable — "the household has held this" means
 * settled knowing.
 */
import { describe, it, expect } from "vitest";
import { pickCitation } from "../../src/whisper/service.js";

const standing = [
  { thread: "th_clause_pub", letterId: "l_pub", text: "the pub closes at dusk" },
  { thread: "th_clause_quiet", letterId: "l_quiet", text: "the house holds quiet hours after midnight" },
];

describe("pickCitation", () => {
  it("cites the best standing clause above the threshold", () => {
    const hits = [
      { letterId: "l_pub", score: 0.61 },
      { letterId: "l_quiet", score: 0.55 },
    ];
    const citation = pickCitation(hits, standing);
    expect(citation).toEqual({ thread: "th_clause_pub", excerpt: "the pub closes at dusk" });
  });

  it("returns null when no standing clause clears the threshold", () => {
    const hits = [{ letterId: "l_pub", score: 0.4 }];
    expect(pickCitation(hits, standing)).toBeNull();
  });

  it("returns null when there are no standing clauses", () => {
    const hits = [{ letterId: "l_pub", score: 0.9 }];
    expect(pickCitation(hits, [])).toBeNull();
  });

  it("ignores hits for clauses that are not standing", () => {
    // A proposed clause is still before the household; a contested one is
    // held in dissent; a reversed one is no longer held. None are citable.
    const hits = [
      { letterId: "l_proposed", score: 0.9 },
      { letterId: "l_pub", score: 0.52 },
    ];
    const citation = pickCitation(hits, standing);
    expect(citation).toEqual({ thread: "th_clause_pub", excerpt: "the pub closes at dusk" });
  });

  it("truncates long clause text to the excerpt length", () => {
    const long = { thread: "th_clause_long", letterId: "l_long", text: "x".repeat(300) };
    const citation = pickCitation([{ letterId: "l_long", score: 0.7 }], [long]);
    expect(citation!.excerpt.length).toBeLessThan(200);
    expect(citation!.excerpt.endsWith("…")).toBe(true);
  });

  it("honours a custom threshold", () => {
    const hits = [{ letterId: "l_pub", score: 0.45 }];
    expect(pickCitation(hits, standing, 0.4)).toEqual({
      thread: "th_clause_pub",
      excerpt: "the pub closes at dusk",
    });
    expect(pickCitation(hits, standing, 0.5)).toBeNull();
  });
});
