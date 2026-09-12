/**
 * The whisper card's actions — the one behaviour with a promise in it.
 *
 * A whisper offers Open only when there is a room to land in: a thread or a
 * frame. A door-knock carries an address, not a target, so its card must not
 * offer an action that resolves to silence (design adherence pass 03, held by
 * the whisper test here). Rendered with react-dom/server — no jsdom needed.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import WhisperSidebar from "./WhisperSidebar";
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
      onUndismiss={() => {}}
      onGaps={() => {}}
      onWriteBack={() => {}}
      onCite={() => {}}
    />,
  );
}

describe("WhisperSidebar — Open only when there is a room to land in", () => {
  it("hides Open for a door-knock — it carries an address, not a target", () => {
    const html = sidebar(
      whisper({
        kind: "door-knock",
        targetAddress: "you@house",
        summary: "Someone knocked at your door with a key that does not fit.",
      }),
    );
    expect(html).toContain("Write back");
    expect(html).toContain("Dismiss");
    expect(html).not.toContain(">Open</button>");
  });

  it("offers Open when the whisper carries a thread", () => {
    const html = sidebar(whisper({ kind: "gap-dormant-thread", targetThread: "th_1" }));
    expect(html).toContain(">Open</button>");
  });

  it("offers Open when the whisper carries a frame", () => {
    const html = sidebar(
      whisper({ kind: "gap-unvisited-corner", targetFrame: "run:tech-week" }),
    );
    expect(html).toContain(">Open</button>");
  });
});

describe("WhisperSidebar — dismissal is reversible", () => {
  it("keeps a dismissed offer on hand, quieted, with the Keep move", () => {
    const html = sidebar(
      whisper({
        kind: "gap-dormant-thread",
        targetThread: "th_1",
        dismissedAt: "2026-09-11T01:00:00.000Z",
      }),
    );
    // The card stays — the .dismissed treatment quiets it, and the
    // reversal (Keep → undismiss) is reachable. A dismissal is one tap,
    // but it is never a dead end.
    expect(html).toContain("whisper-card dismissed");
    expect(html).toContain(">Keep</button>");
    expect(html).not.toContain(">Dismiss</button>");
  });
});
