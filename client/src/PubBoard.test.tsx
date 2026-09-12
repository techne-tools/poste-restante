/**
 * The pub board — the notice-board contract.
 *
 * The pub must read as a shared public space, distinct from the private
 * mailbox (design.json → surfaces.pub). That distinction lives in the
 * `.pub` class the board carries: the notice-board letter rows and the
 * mono `posted` marker key on it (styles.css → `.pub .letter-row`).
 * PubBoard is extracted so that contract is testable without a live fetch.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PubBoard from "./PubBoard";
import type { PubConversation } from "./pubUtils";
import type { Letter } from "./api";

function letter(over: Partial<Letter> = {}): Letter {
  return {
    id: "l_pub_1",
    envelope: {
      from: "hermes@house",
      to: ["pub@house"],
      cc: [],
      thread: "th_pub_1",
      kind: "letter",
      lang: "en-AU",
      subject: "On the winter of the show",
    },
    time: { gregorian: "2026-09-12T09:14:00+04:00", frames: [] },
    body: { format: "markdown", content: "the score needs a quieter second act" },
    receivedAt: "2026-09-12T09:14:00+04:00",
    pinnedAt: null,
    pinnedBy: null,
    ...over,
  };
}

function conversation(): PubConversation {
  const l = letter();
  return {
    thread: l.envelope.thread,
    title: l.envelope.subject,
    letters: [l],
    lastAt: l.receivedAt,
  };
}

describe("PubBoard — the notice-board contract", () => {
  it("carries the .pub wrapper the notice-board styles key on", () => {
    const html = renderToStaticMarkup(
      <PubBoard conversations={[conversation()]} onOpenThread={() => {}} />,
    );
    expect(html).toContain('class="pub pub-board"');
    expect(html).toContain('class="posted"');
    expect(html).toContain("last letter");
    expect(html).toContain("On the winter of the show");
  });

  it("names the room the community's word, or the fallback", () => {
    const named = renderToStaticMarkup(
      <PubBoard name="the tavern" conversations={[]} onOpenThread={() => {}} />,
    );
    expect(named).toContain("the tavern");
    const fallback = renderToStaticMarkup(
      <PubBoard conversations={[]} onOpenThread={() => {}} />,
    );
    expect(fallback).toContain("the pub");
  });

  it("keeps the empty board quiet", () => {
    const html = renderToStaticMarkup(
      <PubBoard conversations={[]} onOpenThread={() => {}} />,
    );
    expect(html).toContain("The pub is quiet");
  });
});
