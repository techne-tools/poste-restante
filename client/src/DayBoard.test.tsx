/**
 * The day board — the callsheet.
 *
 * Locked here: the room's name is the community's (or the founding fallback),
 * a frame column shows its letters and a quiet empty frame, the instruments,
 * offers, and cited clauses each render, and an empty day stays open. The
 * board is a working document — no counts, no badges.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import DayBoard from "./DayBoard";
import type { DayProjection } from "./api";

const noop = () => {};

function projection(over: Partial<DayProjection> = {}): DayProjection {
  return {
    frames: [
      {
        frame: "production:tempest",
        letters: [
          {
            letterId: "l_1",
            thread: "th_1",
            subject: "On the winter of the show",
            kind: "letter",
            from: "hermes@house",
            receivedAt: "2026-09-12T09:14:00+04:00",
            frames: [],
          },
        ],
      },
      { frame: "season:autumn", letters: [] },
    ],
    agents: [
      {
        address: "hermes@house",
        task: "transcribe the day's audio",
        creator: "you@house",
        lifespanFrame: null,
      },
    ],
    whispers: [
      {
        id: "w_1",
        kind: "gap-dormant-thread",
        summary: "A question has gone unanswered.",
        targetThread: "th_1",
        targetFrame: null,
      },
    ],
    clauses: [{ thread: "th_clause_1", text: "the archive keeps what is written", state: "standing" }],
    ...over,
  };
}

describe("DayBoard — the callsheet", () => {
  it("names the room the community's word, or the founding fallback", () => {
    const named = renderToStaticMarkup(
      <DayBoard projection={projection()} onOpenThread={noop} name="the day book" />,
    );
    expect(named).toContain("the day book");
    const fallback = renderToStaticMarkup(
      <DayBoard projection={projection()} onOpenThread={noop} />,
    );
    expect(fallback).toContain("the day");
  });

  it("shows a frame column with its letters, and a quiet empty frame", () => {
    const html = renderToStaticMarkup(<DayBoard projection={projection()} onOpenThread={noop} />);
    expect(html).toContain("production:tempest");
    expect(html).toContain("On the winter of the show");
    expect(html).toContain("season:autumn");
    expect(html).toContain("no letters in this frame");
  });

  it("shows instruments, offers, and cited clauses", () => {
    const html = renderToStaticMarkup(<DayBoard projection={projection()} onOpenThread={noop} />);
    expect(html).toContain("instruments on the day");
    expect(html).toContain("transcribe the day");
    expect(html).toContain("what the house is offering");
    expect(html).toContain("held by the household");
    expect(html).toContain("the archive keeps what is written");
  });

  it("keeps the empty day open", () => {
    const html = renderToStaticMarkup(
      <DayBoard
        projection={projection({ frames: [], agents: [], whispers: [], clauses: [] })}
        onOpenThread={noop}
      />,
    );
    expect(html).toContain("Nothing is on today — the day is open.");
  });
});
