/**
 * The put-away and left surfaces — the safety move stays.
 *
 * Putting a thread away gentles the house's offers; it must not take away the
 * resident's safety moves (design adherence pass 04). The put-away surface
 * keeps `Leave` and `Scrub` beside `Bring it back`; the left surface keeps
 * `Scrub` and offers `Rejoin`. Rendered with react-dom/server — no jsdom.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ThreadStateSurface } from "./ThreadView";

const noop = () => {};

const scrub = <button className="door-link">Scrub my part of this thread</button>;

function surface(state: "out" | "shelved"): string {
  return renderToStaticMarkup(
    <ThreadStateSurface
      state={state}
      acting={false}
      scrubControl={scrub}
      onLeave={noop}
      onRejoin={noop}
      onBringBack={noop}
    />,
  );
}

describe("ThreadStateSurface — the safety move stays", () => {
  it("the put-away surface keeps Leave and Scrub beside Bring it back", () => {
    const html = surface("shelved");
    expect(html).toContain("This correspondence is put away.");
    expect(html).toContain("Bring it back");
    expect(html).toContain("Leave this correspondence");
    expect(html).toContain("Scrub my part of this thread");
  });

  it("the left surface keeps Scrub and offers Rejoin, not Leave", () => {
    const html = surface("out");
    expect(html).toContain("You have left this correspondence.");
    expect(html).toContain("Rejoin this correspondence");
    expect(html).toContain("Scrub my part of this thread");
    expect(html).not.toContain("Leave this correspondence");
  });

  it("renders the state as a serif panel with exactly one primary", () => {
    for (const state of ["out", "shelved"] as const) {
      const html = surface(state);
      expect(html).toContain('class="thread-state"');
      expect(html).toContain('class="state-line"');
      // Each held state offers one decisive act, never two.
      expect((html.match(/class="primary"/g) ?? []).length).toBe(1);
    }
  });

  it("holds the primary while a move is in flight", () => {
    const html = renderToStaticMarkup(
      <ThreadStateSurface
        state="shelved"
        acting
        scrubControl={scrub}
        onLeave={noop}
        onRejoin={noop}
        onBringBack={noop}
      />,
    );
    // The door is not half-lit: while a move runs, the primary is held.
    expect(html).toMatch(/<button class="primary"[^>]*disabled/);
  });
});
