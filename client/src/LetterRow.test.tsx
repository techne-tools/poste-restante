/**
 * The letter's row — one shape, no dead classes.
 *
 * Locked here: the Horizon intersection only classes the rows that change
 * weight (`partial`, `dim`); `full` and `none` rest at full weight and carry
 * no class (adherence rule 4 — no class ships without a rule). And a sealed
 * letter reads as "sealed letter", never a hash.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import LetterRow from "./LetterRow";
import type { Letter } from "./api";

const noop = () => {};

function letter(over: Partial<Letter> = {}): Letter {
  return {
    id: "l_1",
    envelope: {
      from: "hermes@house",
      to: ["you@house"],
      cc: [],
      thread: "th_1",
      kind: "letter",
      lang: "en-AU",
      subject: "On the winter of the show",
    },
    time: { gregorian: "2026-09-12T09:14:00+04:00", frames: [] },
    body: { format: "markdown", content: "the storm cue moves to 47." },
    receivedAt: "2026-09-12T09:14:00+04:00",
    pinnedAt: null,
    pinnedBy: null,
    ...over,
  };
}

describe("LetterRow — one shape, no dead classes", () => {
  it("rests at full weight for 'full' and 'none' — no class without a rule", () => {
    for (const state of ["none", "full"] as const) {
      const html = renderToStaticMarkup(<LetterRow letter={letter()} onClick={noop} state={state} />);
      expect(html).toContain('class="letter-row"');
      expect(html).not.toContain("letter-row full");
    }
  });

  it("dims for the intersection — partial and dim carry their class", () => {
    expect(
      renderToStaticMarkup(<LetterRow letter={letter()} onClick={noop} state="partial" />),
    ).toContain('class="letter-row partial"');
    expect(
      renderToStaticMarkup(<LetterRow letter={letter()} onClick={noop} state="dim" />),
    ).toContain('class="letter-row dim"');
  });

  it("shows the pin marker only when pinned", () => {
    expect(renderToStaticMarkup(<LetterRow letter={letter()} onClick={noop} pinned />)).toContain(
      "pinned",
    );
    expect(renderToStaticMarkup(<LetterRow letter={letter()} onClick={noop} />)).not.toContain(
      "pinned",
    );
  });

  it("shows a sealed letter as 'sealed letter', never a hash", () => {
    const sealed = letter({
      body: { format: "sealed", content: "age1cipher-armored", recipients: [], signature: "s" },
    });
    const html = renderToStaticMarkup(<LetterRow letter={sealed} onClick={noop} />);
    expect(html).toContain("sealed letter");
    expect(html).not.toContain("age1cipher-armored");
  });
});
