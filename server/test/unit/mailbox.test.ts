/**
 * Mailbox materialisation (unit) — movement B's pure engine (SPEC §5 #12).
 *
 * The mailbox is a DERIVED view: same letters → same UIDs, same folders,
 * same messages, every sync. These tests prove the derivation invariants
 * hermetically — no sidecar, no network — exactly like the door's
 * translation unit tests.
 */
import { describe, it, expect } from "vitest";
import {
  INBOX,
  SENT,
  ARCHIVE,
  uidForLetter,
  frameFolder,
  folderForLetter,
  translateToMailbox,
  type MailFlagState,
} from "../../src/bridge/mailbox.js";
import type { StoredLetter } from "../../src/types.js";

const mkStored = (over: Partial<StoredLetter> = {}): StoredLetter => ({
  envelope: {
    from: "you@house",
    to: ["hermes@house"],
    cc: [],
    thread: "th_9f2c1",
    kind: "letter",
    lang: "en-AU",
    subject: "the storm cue",
  },
  time: { gregorian: "2026-09-04T10:00:00+04:00", frames: [] },
  body: { format: "markdown", content: "Move the **storm cue** to 47." },
  id: "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890",
  receivedAt: new Date("2026-09-04T10:00:00+04:00"),
  bodyText: "Move the storm cue to 47.",
  ...over,
});

const NO_FLAGS: MailFlagState = { seen: false, answered: false, flagged: false };

describe("uidForLetter", () => {
  it("is deterministic — the same letter id always yields the same uid", () => {
    const id =
      "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890";
    expect(uidForLetter(id)).toBe(uidForLetter(id));
  });

  it("derives from the letter hash, not the caller — same id across systems", () => {
    // First 8 hex chars of the id are the UID's raw bits.
    expect(uidForLetter("a1b2c3d4e5f67890")).toBe(Number.parseInt("a1b2c3d4", 16));
  });

  it("differs when the letter differs (different envelope → different id → different uid)", () => {
    const a = mkStored({ id: "aaaaaaaaaaaaaaaa" });
    const b = mkStored({ id: "bbbbbbbbbbbbbbbb" });
    expect(uidForLetter(a.id!)).not.toBe(uidForLetter(b.id!));
  });

  it("is a 32-bit value (fits IMAP's UID space)", () => {
    const id = "ffffffffffffffffffffffffffffffff";
    const uid = uidForLetter(id);
    expect(uid).toBeGreaterThanOrEqual(1);
    expect(uid).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("folderForLetter", () => {
  const letter = (frames: { frame: string; value: string }[]) =>
    mkStored({ time: { gregorian: "2026-09-04T10:00:00+04:00", frames } });

  it("places a letter in its most recent active frame, not a passive one", () => {
    const l = letter([
      { frame: "production", value: "tempest-tech-week" },
      { frame: "season", value: "autumn" },
    ]);
    expect(
      folderForLetter({
        letter: l,
        resident: "you@house",
        activeFrames: ["season:autumn", "production:tempest-tech-week"],
      }),
    ).toBe("production:tempest-tech-week");
  });

  it("does not place a letter in a frame the resident is not tracking", () => {
    // Received mail (from ≠ resident) in an untracked frame → Inbox,
    // never a frame folder the resident does not work in. A SENT letter in
    // an untracked frame goes to Sent — covered by its own test below.
    const received = mkStored({
      envelope: { ...mkStored().envelope, from: "hermes@house" },
      time: {
        gregorian: "2026-09-04T10:00:00+04:00",
        frames: [{ frame: "production", value: "tempest-tech-week" }],
      },
    });
    expect(
      folderForLetter({
        letter: received,
        resident: "you@house",
        activeFrames: ["season:autumn"],
      }),
    ).toBe(INBOX);
  });

  it("places mail the resident sent in Sent", () => {
    const l = mkStored({ envelope: { ...mkStored().envelope, from: "you@house" } });
    expect(
      folderForLetter({ letter: l, resident: "you@house", activeFrames: [] }),
    ).toBe(SENT);
  });

  it("places received mail with no active frame in Inbox", () => {
    const l = mkStored({ envelope: { ...mkStored().envelope, from: "hermes@house" } });
    expect(
      folderForLetter({ letter: l, resident: "you@house", activeFrames: [] }),
    ).toBe(INBOX);
  });

  it("prefers the frame even for Sent mail — the resident wrote into a frame", () => {
    const l = mkStored({
      envelope: { ...mkStored().envelope, from: "you@house" },
      time: {
        gregorian: "2026-09-04T10:00:00+04:00",
        frames: [{ frame: "production", value: "tempest-tech-week" }],
      },
    });
    expect(
      folderForLetter({
        letter: l,
        resident: "you@house",
        activeFrames: ["production:tempest-tech-week"],
      }),
    ).toBe("production:tempest-tech-week");
  });
});

describe("translateToMailbox", () => {
  it("derives a stable message identity — uid, messageId, references", () => {
    const letter = mkStored();
    const m1 = translateToMailbox({
      letter,
      resident: "you@house",
      activeFrames: [],
      flags: NO_FLAGS,
    });
    const m2 = translateToMailbox({
      letter,
      resident: "you@house",
      activeFrames: [],
      flags: NO_FLAGS,
    });
    expect(m1).toEqual(m2);
    expect(m1.messageId).toBe(`<${letter.id}@house>`);
    expect(m1.references).toEqual([`<${letter.envelope.thread}@house>`]);
    expect(m1.inReplyTo).toBeNull();
  });

  it("carries the RFC5322 surface: date, from, to, cc, subject", () => {
    const m = translateToMailbox({
      letter: mkStored(),
      resident: "you@house",
      activeFrames: [],
      flags: NO_FLAGS,
    });
    expect(m.date).toBe("Fri, 04 Sep 2026 06:00:00 GMT");
    expect(m.from).toBe("you@house");
    expect(m.to).toEqual(["hermes@house"]);
    expect(m.cc).toEqual([]);
    expect(m.subject).toBe("the storm cue");
  });

  it("renders the body as plain text — IMAP carries text, the archive keeps markdown", () => {
    const m = translateToMailbox({
      letter: mkStored(),
      resident: "you@house",
      activeFrames: [],
      flags: NO_FLAGS,
    });
    expect(m.bodyText).toBe("Move the storm cue to 47.");
    // The markdown is NOT lost — the archive holds it; the mailbox is a view.
    expect(m.bodyText).not.toContain("**");
  });

  it("threads by the house's thread reference, not one folder per thread", () => {
    const a = mkStored({ id: "aaaaaaaaaaaaaaaa" });
    const b = mkStored({ id: "bbbbbbbbbbbbbbbb", envelope: { ...mkStored().envelope } });
    const ma = translateToMailbox({
      letter: a,
      resident: "you@house",
      activeFrames: [],
      flags: NO_FLAGS,
    });
    const mb = translateToMailbox({
      letter: b,
      resident: "you@house",
      activeFrames: [],
      flags: NO_FLAGS,
    });
    expect(ma.references).toEqual(mb.references);
  });

  it("passes the learning-loop flags through (the only client-writable surface)", () => {
    const m = translateToMailbox({
      letter: mkStored(),
      resident: "you@house",
      activeFrames: [],
      flags: { seen: true, answered: true, flagged: false },
    });
    expect(m.flags).toEqual({ seen: true, answered: true, flagged: false });
  });

  it("derives the same view from a wiped and re-synced archive — UID stability", () => {
    const letters = [
      mkStored({ id: "aaaaaaaaaaaaaaaa" }),
      mkStored({ id: "bbbbbbbbbbbbbbbb", envelope: { ...mkStored().envelope, from: "hermes@house" } }),
      mkStored({
        id: "cccccccccccccccc",
        time: {
          gregorian: "2026-09-04T10:00:00+04:00",
          frames: [{ frame: "production", value: "tempest-tech-week" }],
        },
      }),
    ];
    const activeFrames = ["production:tempest-tech-week"];
    const view = (l: StoredLetter) =>
      translateToMailbox({ letter: l, resident: "you@house", activeFrames, flags: NO_FLAGS });
    const first = letters.map(view);
    const second = letters.map(view); // wiping + re-deriving yields the same rows
    expect(second).toEqual(first);
    expect(new Set(first.map((m) => m.uid)).size).toBe(3);
    const folders = first.map((m) => m.folder);
    expect(folders).toContain(SENT);
    expect(folders).toContain(INBOX);
    expect(folders).toContain("production:tempest-tech-week");
  });
});

describe("frameFolder", () => {
  it("names a folder from a frame: name:value", () => {
    expect(frameFolder("production", "tempest-tech-week")).toBe(
      "production:tempest-tech-week",
    );
  });
});

// ARCHIVE is a constant the caller composes around; assert it exists so a
// rename cannot silently break the B2 sync layer.
describe("folder constants", () => {
  it("exports the fixed folders", () => {
    expect(INBOX).toBe("Inbox");
    expect(SENT).toBe("Sent");
    expect(ARCHIVE).toBe("Archive");
  });
});
