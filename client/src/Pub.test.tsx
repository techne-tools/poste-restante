/**
 * The pub's open conversation — the view's contract.
 *
 * A conversation opens to its letters (oldest-first), titled in the serif
 * voice, with the back control returning to the board and the reply offered
 * only to a resident. PubConversation is extracted so this is testable
 * without a live fetch — Pub itself only composes.
 */
import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import PubConversation from "./PubConversation";
import type { Letter } from "./api";
import type { PubConversation as PubConversationData } from "./pubUtils";

function mk(id: string, subject: string, receivedAt: string): Letter {
  return {
    id,
    envelope: {
      from: "hermes@house",
      to: ["pub@house"],
      cc: [],
      thread: "th_pub_1",
      kind: "letter",
      lang: "en-AU",
      subject,
    },
    time: { gregorian: receivedAt, frames: [] },
    body: { format: "markdown", content: `${subject}, plainly said.` },
    receivedAt,
    pinnedAt: null,
    pinnedBy: null,
  };
}

function conversation(): PubConversationData {
  const older = mk("l_1", "the storm cue", "2026-09-12T09:00:00+04:00");
  const newer = mk("l_2", "the quiet act", "2026-09-12T11:00:00+04:00");
  return {
    thread: "th_pub_1",
    // A title distinct from the letter subjects, so an order assertion on
    // the row subjects is not confused by the ledger's own title.
    title: "the tempest thread",
    letters: [older, newer],
    lastAt: newer.receivedAt,
  };
}

describe("PubConversation — the open conversation", () => {
  it("carries the back control to the pub", () => {
    const html = renderToStaticMarkup(
      <PubConversation conversation={conversation()} onBack={() => {}} onOpenLetter={() => {}} />,
    );
    expect(html).toContain('class="back"');
    expect(html).toContain("← Back to the pub");
    expect(html).toContain("the tempest thread");
  });

  it("reads the letters oldest-first", () => {
    const html = renderToStaticMarkup(
      <PubConversation conversation={conversation()} onBack={() => {}} onOpenLetter={() => {}} />,
    );
    const older = html.indexOf("the storm cue");
    const newer = html.indexOf("the quiet act");
    expect(older).toBeGreaterThan(-1);
    expect(newer).toBeGreaterThan(-1);
    expect(older).toBeLessThan(newer);
  });

  it("offers the reply to a resident, and never to a guest", () => {
    const guest = renderToStaticMarkup(
      <PubConversation conversation={conversation()} onBack={() => {}} onOpenLetter={() => {}} />,
    );
    expect(guest).not.toContain("Write back to this conversation");

    const resident = renderToStaticMarkup(
      <PubConversation
        conversation={conversation()}
        onBack={() => {}}
        onOpenLetter={() => {}}
        onReply={() => {}}
      />,
    );
    expect(resident).toContain("Write back to this conversation");
  });
});
