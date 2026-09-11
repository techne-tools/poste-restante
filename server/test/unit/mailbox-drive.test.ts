/**
 * The mailbox sync drive (unit) — SPEC §5 #12, the piece that makes the
 * mailbox seam live (B1 engine + B2a state machine + B2b adapter would
 * otherwise never be driven). These tests pin the drive's mechanics:
 *
 *   - The subject is the provisioned account — NO accounts, NO sync. The
 *     drive never scopes by address; it scopes by account row (privacy as
 *     schema).
 *   - Each resident's pass resolves visible rows + active frame folders
 *     through the drive's deps (the repo's own visibility query is the
 *     caller's — proven live in the integration suite) and mirrors through
 *     the writer seam.
 *   - Overlap safety: a pass never starts while one is running.
 *   - Failure isolation: one resident's writer failure is logged and never
 *     stops the house for the others.
 *   - Log discipline: the drive logs event names and counts only — and
 *     redacts the URL (with its sidecar credential) out of error messages.
 *   - Timer ownership: the heartbeat is unref'd and stop() is idempotent.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import {
  MailboxSyncDrive,
  redactUrl,
  type MailboxSyncDriveDeps,
} from "../../src/bridge/mailbox-drive.js";
import type { MailboxWriter, MailboxSyncSource } from "../../src/bridge/sync.js";
import type { MailboxAccount } from "../../src/bridge/mailbox-accounts.js";

const info = vi.fn<(event: string, fields?: Record<string, unknown>) => void>();
const warn = vi.fn<(event: string, fields?: Record<string, unknown>) => void>();

const baseRow = (over: Partial<MailboxSyncSource["letter"]> = {}): MailboxSyncSource["letter"] => ({
  id: "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890",
  from_addr: "you@house",
  to_addrs: ["hermes@house"],
  cc_addrs: [],
  thread_id: "th_9f2c1",
  kind: "letter",
  lang: "en-AU",
  subject: "the storm cue — drive",
  body: "Move the **storm cue** to 47.",
  body_text: "Move the storm cue to 47.",
  received_at: new Date("2026-09-04T06:00:00Z"),
  pinned_at: null,
  frames: [],
  ...over,
});

const mkSource = (over: Partial<MailboxSyncSource["letter"]> = {}, threadReplied = false): MailboxSyncSource =>
  ({ letter: baseRow(over), threadReplied });

const mkAccount = (over: Partial<MailboxAccount> = {}): MailboxAccount => ({
  address: "you@house",
  url: "imap://you@house.test:house-dev-sidecar@127.0.0.1:11430/",
  createdAt: new Date("2026-09-04T06:00:00Z"),
  ...over,
});

/** An in-memory writer — proves the writer seam received the folder/message
 *  shape without a network. */
class FakeWriter implements MailboxWriter {
  folders = new Set<string>();
  messages = new Map<string, Set<string>>();
  failures: Record<string, Error> = {};
  /** What readBack observes — empty by default (nothing to report). */
  observes: { letterId: string; seen: boolean; answered: boolean }[] = [];

  async ensureFolder(name: string): Promise<void> {
    if (this.failures[name]) throw this.failures[name];
    this.folders.add(name);
    this.messages.set(name, new Set());
  }

  async upsertByUid(_folder: string, _uid: number, _message: never): Promise<boolean> {
    return true;
  }

  async readBack() {
    return this.observes;
  }
}

function deps(
  over: Partial<{
    accounts: MailboxAccount[];
    rows: MailboxSyncSource[];
    frames: string[];
    writer: MailboxWriter;
    writerFor: (account: MailboxAccount) => MailboxWriter;
    tlsInsecure: boolean;
  }> = {},
): MailboxSyncDriveDeps & { writer: FakeWriter } {
  const writer = (over.writer instanceof FakeWriter ? over.writer : new FakeWriter()) as FakeWriter;
  const reads = {
    open: vi.fn(async () => undefined),
    replied: vi.fn(async () => undefined),
  };
  return {
    accounts: {
      list: vi.fn(async () => over.accounts ?? [mkAccount()]),
    },
    repo: {
      lettersForMailboxSync: vi.fn(async (): Promise<MailboxSyncSource[]> => over.rows ?? []),
      activeFrameIds: vi.fn(async (): Promise<string[]> => over.frames ?? []),
    },
    reads,
    log: { info, warn } as unknown as import("../../src/pipeline/logger.js").Logger,
    tlsInsecure: over.tlsInsecure,
    writerFor:
      over.writerFor ?? (() => writer),
  };
}

describe("MailboxSyncDrive", () => {
  afterEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
  });

  it("does nothing when no accounts are provisioned", async () => {
    const d = deps({ accounts: [] });
    const drive = new MailboxSyncDrive(d, 60_000);
    const attempted = await drive.runPass();
    expect(attempted).toBe(0);
    expect(d.repo.lettersForMailboxSync).not.toHaveBeenCalled();
  });

  it("syncs every provisioned account once", async () => {
    const d = deps({
      accounts: [mkAccount({ address: "you@house" }), mkAccount({ address: "hermes@house" })],
      rows: [mkSource()],
      frames: ["production:tempest-tech-week"],
    });
    const drive = new MailboxSyncDrive(d, 60_000);
    const attempted = await drive.runPass();
    expect(attempted).toBe(2);
    expect(d.repo.lettersForMailboxSync).toHaveBeenCalledTimes(2);
    expect(d.repo.lettersForMailboxSync).toHaveBeenCalledWith("you@house");
    expect(d.repo.lettersForMailboxSync).toHaveBeenCalledWith("hermes@house");
    expect(d.repo.activeFrameIds).toHaveBeenCalledWith("you@house");
  });

  it("skips a pass while a previous pass is still running", async () => {
    let releaseAll: () => void = () => {};
    const gate = new Promise<void>((resolve) => (releaseAll = () => resolve()));
    const d = deps({
      accounts: [mkAccount({ address: "you@house" })],
      writerFor: () => ({
        ensureFolder: async () => {
          await gate; // hold the pass open
        },
        upsertByUid: async () => true,
        readBack: async () => [],
      } as MailboxWriter),
    });
    const drive = new MailboxSyncDrive(d, 60_000);
    const first = drive.runPass();
    // A second pass while the first is still gated must be a no-op.
    const second = await drive.runPass();
    expect(second).toBe(0);
    expect(warn).toHaveBeenCalledWith("mailbox:pass-skipped", { reason: "overlap" });
    releaseAll();
    await first;
  });

  it("isolates one resident's failure — the house keeps syncing the others", async () => {
    const goodWriter = new FakeWriter();
    const d = deps({
      accounts: [mkAccount({ address: "broken@house" }), mkAccount({ address: "you@house" })],
      rows: [mkSource()],
      writerFor: (account) =>
        account.address === "broken@house"
          ? ({
              ensureFolder: async () => {
                throw new Error(
                  "connection failed for broken@127.0.0.1:993 with broken-secret",
                );
              },
              upsertByUid: async () => true,
              readBack: async () => [],
            } as MailboxWriter)
          : (goodWriter as MailboxWriter),
    });
    const drive = new MailboxSyncDrive(d, 60_000);
    const attempted = await drive.runPass();
    expect(attempted).toBe(2);
    // Both accounts were resolved…
    expect(d.repo.lettersForMailboxSync).toHaveBeenCalledTimes(2);
    expect(d.repo.lettersForMailboxSync).toHaveBeenCalledWith("broken@house");
    expect(d.repo.lettersForMailboxSync).toHaveBeenCalledWith("you@house");
    // …the broken one failed loudly but the good one still synced.
    expect(warn).toHaveBeenCalledWith("mailbox:pass-error", expect.objectContaining({}));
    expect(goodWriter.folders.size).toBeGreaterThan(0);
  });

  it("logs account-URL error messages with the credential redacted", async () => {
    const fail = new Error("connection failed for you@house.test:house-dev-sidecar@127.0.0.1:11430");
    const d = deps({
      accounts: [mkAccount()],
      writerFor: () => ({
        ensureFolder: async () => {
          throw fail;
        },
        upsertByUid: async () => true,
        readBack: async () => [],
      } as MailboxWriter),
    });
    const drive = new MailboxSyncDrive(d, 60_000);
    await drive.runPass();
    const logged = warn.mock.calls.find(([event]) => event === "mailbox:pass-error")?.[1]?.error as string;
    expect(logged).toContain("***@127.0.0.1:11430");
    expect(logged).not.toContain("house-dev-sidecar");
  });

  it("redactUrl strips the userinfo credential and leaves the host", () => {
    const message = "boom you@house.test:house-dev-sidecar@127.0.0.1:11430 gone";
    const out = redactUrl(message, "imap://you@house.test:house-dev-sidecar@127.0.0.1:11430/");
    expect(out).toBe("boom ***@127.0.0.1:11430 gone");
    expect(out).not.toContain("house-dev-sidecar");
  });

  it("records read-back flags into the house's read state", async () => {
    const writer = new FakeWriter();
    writer.observes = [
      { letterId: "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890", seen: true, answered: false },
      { letterId: "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef", seen: true, answered: true },
      { letterId: "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210", seen: false, answered: false },
    ];
    const d = deps({ writer });
    const drive = new MailboxSyncDrive(d, 60_000);
    await drive.runPass();
    expect(d.reads.open).toHaveBeenCalledWith(
      "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890",
      "you@house",
    );
    expect(d.reads.open).toHaveBeenCalledWith(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "you@house",
    );
    expect(d.reads.replied).toHaveBeenCalledWith(
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
      "you@house",
    );
    // Untouched letter — no open, no reply.
    expect(d.reads.open).not.toHaveBeenCalledWith(
      "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210",
      expect.anything(),
    );
  });

  it("read-back failure is isolated — logged, never fatal to the pass", async () => {
    const failing = {
      ensureFolder: async () => undefined,
      upsertByUid: async () => true,
      readBack: async () => {
        throw new Error("read-back boom");
      },
    };
    const d = deps({ writerFor: () => failing as unknown as MailboxWriter });
    const drive = new MailboxSyncDrive(d, 60_000);
    const attempted = await drive.runPass();
    expect(attempted).toBe(1);
    expect(warn).toHaveBeenCalledWith("mailbox:read-back-failed", expect.objectContaining({}));
  });

  it("start() arms the interval and stop() clears it", async () => {
    vi.useFakeTimers();
    const d = deps({ accounts: [] });
    const drive = new MailboxSyncDrive(d, 60_000);
    drive.start();
    expect(vi.getTimerCount()).toBeGreaterThan(0);
    drive.start(); // idempotent — a second start must not stack intervals
    expect(vi.getTimerCount()).toBe(1);
    drive.stop();
    expect(vi.getTimerCount()).toBe(0);
  });
});
