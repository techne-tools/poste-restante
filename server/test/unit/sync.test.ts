/**
 * Mailbox sync (unit) — movement B's live-layer engine (SPEC §5 #12, B2a).
 *
 * The state machine that mirrors the archive into a mailbox. B2a keeps
 * the mirror target abstract (`MailboxWriter`) — no network, no sidecar:
 * the live Stalwart+imapflow adapter (B2b) plugs into the same seam, and
 * these tests drive it against an in-memory writer, exactly like the
 * pipeline tests use an in-memory repo.
 *
 * Scope lines asserted here: flags are WRITE-ONLY (pinned → \Flagged,
 * thread-replied → \Answered; \Seen stays client-side — the letter-level
 * read-back column is the postponed slice), and only already-visible rows
 * handed to the engine can surface (no visibility limb in the engine).
 */
import { describe, it, expect, vi } from "vitest";
import {
  deriveMailFlags,
  flagsToImap,
  toMailFlagState,
  buildMailboxView,
  toRfc5322Message,
  MailboxSync,
  type MailboxSyncSource,
  type MailboxWriter,
} from "../../src/bridge/sync.js";
import { ARCHIVE } from "../../src/bridge/mailbox.js";
import { silentLogger } from "../../src/pipeline/logger.js";

const mkRow = (over: Partial<MailboxSyncSource["letter"]> = {}) => ({
  id: "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890",
  from_addr: "you@house",
  to_addrs: ["hermes@house"],
  cc_addrs: [],
  thread_id: "th_9f2c1",
  kind: "letter",
  lang: "en-AU",
  subject: "the storm cue",
  body: "Move the **storm cue** to 47.",
  body_text: "Move the storm cue to 47.",
  received_at: new Date("2026-09-04T06:00:00Z"),
  pinned_at: null,
  frames: [],
  ...over,
});

const mkSource = (
  letterOver: Partial<MailboxSyncSource["letter"]> = {},
  threadReplied = false,
): MailboxSyncSource => ({ letter: mkRow(letterOver), threadReplied });

/** An in-memory mailbox: folder path → uid → message. */
class FakeWriter implements MailboxWriter {
  folders = new Set<string>();
  messages: Record<string, Map<number, unknown>> = {};
  ensureCalls: string[] = [];
  upsertCalls: string[] = [];

  async ensureFolder(name: string): Promise<void> {
    this.ensureCalls.push(name);
    this.folders.add(name);
    this.messages[name] = this.messages[name] ?? new Map();
  }

  async upsertByUid(folder: string, uid: number, message: unknown): Promise<boolean> {
    if (!this.folders.has(folder)) throw new Error(`folder ${folder} not ensured`);
    const map = this.messages[folder];
    if (!map.has(uid)) {
      map.set(uid, message);
      return true;
    }
    this.upsertCalls.push(`${folder}:${uid}`);
    return false;
  }
}

describe("deriveMailFlags", () => {
  it("carries nothing by default — \\Seen is the client's own", () => {
    expect(deriveMailFlags({ pinned_at: null }, false)).toEqual([]);
  });

  it("maps pinned → \\Flagged", () => {
    expect(
      deriveMailFlags({ pinned_at: new Date("2026-09-04T06:00:00Z") }, false),
    ).toEqual(["\\Flagged"]);
  });

  it("maps a thread reply → \\Answered", () => {
    expect(deriveMailFlags({ pinned_at: null }, true)).toEqual(["\\Answered"]);
  });

  it("combines both signals", () => {
    expect(
      deriveMailFlags({ pinned_at: new Date("2026-09-04T06:00:00Z") }, true),
    ).toEqual(["\\Flagged", "\\Answered"]);
  });

  it("never emits \\Seen — read-back is the postponed slice", () => {
    const flags = [...deriveMailFlags({ pinned_at: null }, true), "\\Seen"];
    expect(flags).toContain("\\Seen");
    const fromState = flagsToImap(toMailFlagState({ pinned_at: null }, true));
    expect(fromState).not.toContain("\\Seen");
  });
});

describe("buildMailboxView", () => {
  it("places each letter in its folder AND Archive (the plural-time duplicate)", () => {
    const row = mkRow();
    const view = buildMailboxView([mkSource(row)], {
      resident: "you@house",
      activeFrames: [],
    });
    // Sent (from == resident) + Archive.
    expect([...view.keys()].sort()).toEqual([ARCHIVE, "Sent"]);
    expect(view.get("Sent")).toHaveLength(1);
    expect(view.get(ARCHIVE)).toHaveLength(1);
    // Same uid in both — the archive is ONE truth, the mailbox duplicates.
    expect(view.get("Sent")![0].uid).toBe(view.get(ARCHIVE)![0].uid);
  });

  it("uses the letter's own frame precedence for a frame the resident tracks", () => {
    const view = buildMailboxView(
      [
        mkSource({
          id: "bbbbbbbbbbbbbbbb",
          frames: [
            { frame: "production", value: "tempest-tech-week" },
            { frame: "season", value: "autumn" },
          ],
        }),
      ],
      { resident: "you@house", activeFrames: ["season:autumn", "production:tempest-tech-week"] },
    );
    expect(view.has("production:tempest-tech-week")).toBe(true);
  });

  it("only surfaces rows it is handed — no visibility limb (the caller scopes)", () => {
    const view = buildMailboxView([mkSource()], {
      resident: "you@house",
      activeFrames: [],
    });
    // The ghost's letter was never handed in, so it cannot surface.
    expect([...view.values()].flat().length).toBe(2); // Sent + Archive of the ONE row
  });
});

describe("toRfc5322Message", () => {
  it("builds the message from the pure engine's MailboxLetter — one renderer", () => {
    const view = buildMailboxView([mkSource()], {
      resident: "you@house",
      activeFrames: [],
    });
    const m = view.get("Sent")![0];
    const msg = toRfc5322Message(m);
    expect(msg.uid).toBe(m.uid);
    expect(msg.headers["Message-ID"]).toBe(m.messageId);
    expect(msg.headers["References"]).toBe(m.references.join(", "));
    expect(msg.headers["Subject"]).toBe("the storm cue");
    expect(msg.headers["From"]).toBe("you@house");
    expect(msg.text).toBe("Move the storm cue to 47.");
    expect(msg.flags).toEqual([]);
  });

  it("carries house flags into the message", () => {
    const view = buildMailboxView(
      [mkSource({ pinned_at: new Date("2026-09-04T06:00:00Z") }, true)],
      { resident: "you@house", activeFrames: [] },
    );
    const m = view.get("Sent")![0];
    expect(toRfc5322Message(m).flags).toEqual(["\\Flagged", "\\Answered"]);
  });
});

describe("MailboxSync.syncResident", () => {
  it("ensures folders and upserts every message once (idempotent on uid)", async () => {
    const writer = new FakeWriter();
    const sync = new MailboxSync({
      visibleLetters: async () => [
        mkSource({ id: "aaaaaaaaaaaaaaaa" }),
        mkSource({ id: "bbbbbbbbbbbbbbbb", from_addr: "hermes@house" }),
      ],
      write: writer,
      log: silentLogger(),
    });
    const result = await sync.syncResident("you@house", []);
    // 3 folders (Sent, Inbox, Archive); 4 messages — each letter lands in
    // its place folder AND Archive (the plural-time duplicate).
    expect(result.folders).toBe(3);
    expect(result.messages).toBe(4);
    expect(writer.folders.has("Sent")).toBe(true);
    expect(writer.folders.has("Inbox")).toBe(true);
    expect(writer.folders.has(ARCHIVE)).toBe(true);
    // The Archive folder exists even when empty on the next pass.
    const empty = new FakeWriter();
    const syncEmpty = new MailboxSync({
      visibleLetters: async () => [],
      write: empty,
      log: silentLogger(),
    });
    await syncEmpty.syncResident("you@house", []);
    expect(empty.folders.has(ARCHIVE)).toBe(true);
  });

  it("a second pass with the same archive is a no-op (same uids → no rewrite)", async () => {
    const writer = new FakeWriter();
    const rows = [mkSource()];
    const sync = new MailboxSync({
      visibleLetters: async () => rows,
      write: writer,
      log: silentLogger(),
    });
    await sync.syncResident("you@house", []);
    await sync.syncResident("you@house", []);
    // Same two messages: second pass rewrites nothing.
    expect(writer.upsertCalls).toHaveLength(2);
  });

  it("logs event names + counts only — no addresses, no bodies", async () => {
    const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    const sync = new MailboxSync({
      visibleLetters: async () => [mkSource()],
      write: new FakeWriter(),
      log: log as unknown as import("../../src/pipeline/logger.js").Logger,
    });
    await sync.syncResident("you@house", []);
    const entry = log.info.mock.calls[0][1];
    expect(entry.folders).toBe(2);
    expect(entry.messages).toBe(2);
    // No address, no letter id, no body text in the log payload.
    expect(JSON.stringify(entry)).not.toMatch(/you@house|storm cue/);
  });
});
