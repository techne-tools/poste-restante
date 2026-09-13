/**
 * The whisper card's actions — the one behaviour with a promise in it.
 *
 * A whisper offers Open only when there is a room to land in: a thread or a
 * frame. A door-knock carries an address, not a target, so its card must not
 * offer an action that resolves to silence; and it is information only — it
 * does not offer Write back either (there is nothing to answer). Dismissal
 * really dismisses: the card leaves the sidebar (nothing lingers half-lit),
 * and no button ever gates the others. Rendered with react-dom/server — no
 * jsdom needed.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import WhisperSidebar from "./components/WhisperSidebar";
import type { Whisper } from "./api";

function whisper(over: Partial<Whisper> = {}): Whisper {
  return {
    id: "w_1",
    letterId: null,
    kind: "house-letter",
    targetThread: null,
    relatedLetterId: null,
    targetFrame: null,
    targetAddress: null,
    citedClause: null,
    citedExcerpt: null,
    summary: "the house has something to say",
    reasoning: null,
    createdAt: "2026-09-11T00:00:00.000Z",
    openedAt: null,
    dismissedAt: null,
    repliedAt: null,
    ...over,
  };
}

function sidebar(w: Whisper): string {
  return renderToStaticMarkup(
    <WhisperSidebar
      whispers={[w]}
      onOpen={() => {}}
      onDismiss={() => {}}
      onGaps={() => {}}
      onWriteBack={() => {}}
      onCite={() => {}}
    />,
  );
}

describe("WhisperSidebar — Open only when there is a room to land in", () => {
  it("hides Open and Write back for a door-knock — information only", () => {
    const html = sidebar(
      whisper({
        kind: "door-knock",
        targetAddress: "you@house",
        summary: "Someone knocked at your door with a key that does not fit.",
      }),
    );
    expect(html).not.toContain(">Open</button>");
    expect(html).not.toContain("Write back");
    expect(html).toContain("Dismiss");
  });

  it("offers Write back and Open when the whisper carries a thread", () => {
    const html = sidebar(whisper({ kind: "gap-dormant-thread", targetThread: "th_1" }));
    expect(html).toContain(">Open</button>");
    expect(html).toContain("Write back");
  });

  it("offers Open when the whisper carries a frame", () => {
    const html = sidebar(
      whisper({ kind: "gap-unvisited-corner", targetFrame: "run:tech-week" }),
    );
    expect(html).toContain(">Open</button>");
  });
});

describe("WhisperSidebar — dismissal really dismisses", () => {
  it("a dismissed offer leaves the sidebar — nothing half-lit", () => {
    const html = sidebar(
      whisper({
        kind: "gap-dormant-thread",
        targetThread: "th_1",
        dismissedAt: "2026-09-11T01:00:00.000Z",
      }),
    );
    // The card is gone; no lingering Keep/Dismiss toggle.
    expect(html).not.toContain("whisper-card");
    expect(html).not.toContain(">Keep</button>");
    expect(html).not.toContain(">Dismiss</button>");
    expect(html).toContain("The house is quiet.");
  });

  it("an undismissed offer keeps its calm actions — none gated by another", () => {
    const html = sidebar(whisper({ kind: "gap-dormant-thread", targetThread: "th_1" }));
    expect(html).toContain(">Write back</button>");
    expect(html).toContain(">Open</button>");
    expect(html).toContain(">Dismiss</button>");
  });
});
