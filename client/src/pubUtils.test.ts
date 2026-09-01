/**
 * Pub logic — unit tests. The pub reads like a channel but operates like a
 * thread: grouping by thread, each conversation oldest-first, ordered by
 * most recent activity, titled by its latest letter's subject.
 */
import { describe, it, expect } from "vitest";
import { groupConversations } from "./pubUtils";
import type { Letter } from "./api";

function letter(id: string, thread: string, subject: string, receivedAt: string): Letter {
  return {
    id,
    envelope: {
      from: "a@house",
      to: ["pub@house"],
      cc: [],
      thread,
      kind: "letter",
      lang: "en-AU",
      subject,
    },
    time: { gregorian: receivedAt, frames: [] },
    body: { format: "markdown", content: "" },
    receivedAt,
    pinnedAt: null,
    pinnedBy: null,
  };
}

describe("groupConversations", () => {
  it("returns [] for an empty pub", () => {
    expect(groupConversations([])).toEqual([]);
  });

  it("groups by thread, each conversation oldest-first", () => {
    const letters = [
      letter("a1", "th_x", "first", "2026-08-01T00:00:00Z"),
      letter("a2", "th_x", "second", "2026-08-03T00:00:00Z"),
      letter("b1", "th_y", "solo", "2026-08-02T00:00:00Z"),
    ];
    const [conv] = groupConversations(letters); // th_x is more active
    expect(conv.letters.map((l) => l.id)).toEqual(["a1", "a2"]);
  });

  it("orders conversations by most recent activity, newest pulse first", () => {
    const letters = [
      letter("a1", "th_x", "old but active", "2026-08-01T00:00:00Z"),
      letter("a2", "th_x", "active", "2026-08-10T00:00:00Z"),
      letter("b1", "th_y", "quiet", "2026-08-02T00:00:00Z"),
    ];
    const convs = groupConversations(letters);
    expect(convs.map((c) => c.thread)).toEqual(["th_x", "th_y"]);
    expect(convs[0]!.lastAt).toBe("2026-08-10T00:00:00Z");
  });

  it("titles a conversation by its latest letter's subject — the serif voice", () => {
    const letters = [
      letter("a1", "th_x", "the first word", "2026-08-01T00:00:00Z"),
      letter("a2", "th_x", "the latest word", "2026-08-03T00:00:00Z"),
    ];
    const [conv] = groupConversations(letters);
    expect(conv.title).toBe("the latest word");
  });

  it("falls back to (no subject), never the machine thread id", () => {
    const letters = [letter("a1", "th_machine_id", "", "2026-08-01T00:00:00Z")];
    const [conv] = groupConversations(letters);
    expect(conv.title).toBe("(no subject)");
  });
});
