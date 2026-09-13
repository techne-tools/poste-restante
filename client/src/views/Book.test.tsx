/**
 * The book — its clause states and its develop flow.
 *
 * Locked here: each state speaks in the house's voice and only the states
 * with a rule carry a class (`offered` rests with none — adherence rule 4);
 * the settling countdown never goes negative; and the develop flow opens
 * with the gated act and its escape, holding the act until the draft
 * carries text.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { STATE_LABEL, daysUntil, clauseClass } from "../utils/bookUtils";
import ClauseDevelop from "../components/ClauseDevelop";

const noop = () => {};
const here = dirname(fileURLToPath(import.meta.url));
const source = (name: string) => readFileSync(join(here, name), "utf8");

describe("the book's clause states", () => {
  it("labels each state in the house's voice", () => {
    expect(STATE_LABEL.proposed).toBe("offered");
    expect(STATE_LABEL.contested).toBe("contested — two voices");
    expect(STATE_LABEL.standing).toBe("standing");
    expect(STATE_LABEL.reversed).toBe("reversed");
  });

  it("only the states with a rule carry a state class", () => {
    expect(clauseClass("proposed")).toBe("clause");
    expect(clauseClass("standing")).toBe("clause clause-standing");
    expect(clauseClass("contested")).toBe("clause clause-contested");
    expect(clauseClass("reversed")).toBe("clause clause-reversed");
  });

  it("counts the settling days, floored at zero", () => {
    const now = new Date("2026-09-12T00:00:00Z").getTime();
    expect(daysUntil("2026-09-15T00:00:00Z", now)).toBe(3);
    expect(daysUntil("2026-09-12T00:00:00Z", now)).toBe(0);
    expect(daysUntil("2026-09-01T00:00:00Z", now)).toBe(0); // never negative
  });
});

describe("the develop flow — a norm reworded", () => {
  it("opens the draft with the gated act and its escape", () => {
    const html = renderToStaticMarkup(
      <ClauseDevelop
        draft="the archive keeps what is written"
        acting={false}
        onDraftChange={noop}
        onDevelop={noop}
        onCancel={noop}
      />,
    );
    expect(html).toContain('class="clause-develop"');
    expect(html).toContain("the archive keeps what is written");
    expect(html).toContain("Develop the norm");
    expect(html).toContain("Put it down");
  });

  it("holds the develop until the draft carries text", () => {
    const empty = renderToStaticMarkup(
      <ClauseDevelop draft="   " acting={false} onDraftChange={noop} onDevelop={noop} onCancel={noop} />,
    );
    expect(empty).toMatch(/class="gated"[^>]*disabled/);

    const ready = renderToStaticMarkup(
      <ClauseDevelop draft="a new wording" acting={false} onDraftChange={noop} onDevelop={noop} onCancel={noop} />,
    );
    expect(ready).not.toMatch(/class="gated"[^>]*disabled/);
  });

  it("holds the act while a develop is in flight", () => {
    const html = renderToStaticMarkup(
      <ClauseDevelop draft="a new wording" acting onDraftChange={noop} onDevelop={noop} onCancel={noop} />,
    );
    expect(html).toContain("…");
    expect(html).toMatch(/class="gated"[^>]*disabled/);
  });
});

describe("the book — support is legible, never hidden", () => {
  it("renders the support act even for the proposer — disabled, with the why on the hand", () => {
    // Rule 10 is a boundary, not an invisibility cloak: the proposer's
    // support renders disabled (the button is on the table, held), and the
    // title names the move instead — "support is another voice; develop
    // instead to move it". The server still refuses the act outright; the
    // surface shows the boundary before the house does.
    const src = source("Book.tsx");
    expect(src).toContain('disabled={acting === c.thread || c.proposedBy === address}');
    expect(src).toContain("you offered this — support is another voice; develop instead to move it");
  });
});
