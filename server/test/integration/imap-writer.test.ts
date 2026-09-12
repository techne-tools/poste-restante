/**
 * The IMAP writer adapter (integration) — movement B's live side meets a
 * real IMAP server (SPEC §5 #12, B2b). Gated by POSTE_RESTANTE_INTEGRATION=1
 * and a running sidecar at IMAP_URL (default
 * `imap://you@house.test:house-dev-sidecar@127.0.0.1:11430/` — the Stalwart
 * dev sidecar bootstrapped per TASK.md: recovery-mode apply of plan.ndjson,
 * then a normal boot; SMTP LOGIN is disabled on cleartext so the adapter
 * authenticates SASL PLAIN via imapflow's AUTH=PLAIN).
 *
 * Prove: a synced letter lands as real mail (folder exists, message is
 * readable, Message-ID is the house uid, write-only flags materialise);
 * re-sync is idempotent — no duplicates, matched by Message-ID (IMAP server
 * uids are meaningless to the house; the house uid lives in the header);
 * a pinned + thread-replied letter carries \Flagged + \Answered and never
 * \Seen (read-back is the POSTPONED slice).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { ImapFlow, type FetchMessageObject } from "imapflow";
import { ImapMailboxWriter, parseImapUrl } from "../../src/bridge/imap-writer.js";
import { MailboxSync, type MailboxSyncSource, type MailboxWriter } from "../../src/bridge/sync.js";
import { silentLogger } from "../../src/pipeline/logger.js";
import { sidecarUp } from "../support/sidecar.js";

const INTEGRATION = process.env.POSTE_RESTANTE_INTEGRATION === "1";
const IMAP_URL =
  process.env.IMAP_URL ??
  "imap://you@house.test:house-dev-sidecar@127.0.0.1:11430/";
// The suite needs the live sidecar; on a host without it, skip rather than
// fail on an unrelated dependency (the sidecar runs on the homelab host).
const SIDECAR_UP = INTEGRATION && (await sidecarUp(IMAP_URL));

interface RowOver {
  id?: string;
  from_addr?: string;
  to_addrs?: string[];
  pinned_at?: Date | null;
  subject?: string;
  body?: string;
  body_text?: string;
  frames?: { frame: string; value: string }[];
  thread_id?: string;
}

const HASH = "a1b2c3d4e5f67890abcdef1234567890abcdef1234567890abcdef1234567890";
const PINNED_HASH = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
// The identity the engine builds: B1's messageId = `<letterId@house>` —
// carried into the RFC5322 Message-ID header by toRfc5322Message. The
// writer and the test match THIS id (never a numeric-uid derivation).
const MESSAGE_ID = `<${HASH}@house>`;
const PINNED_MESSAGE_ID = `<${PINNED_HASH}@house>`;

function mkRow(over: RowOver = {}): MailboxSyncSource["letter"] {
  return {
    id: over.id ?? HASH,
    from_addr: over.from_addr ?? "you@house",
    to_addrs: over.to_addrs ?? ["hermes@house"],
    cc_addrs: [],
    thread_id: over.thread_id ?? "th_9f2c1",
    kind: "letter",
    lang: "en-AU",
    subject: over.subject ?? "the storm cue — b2b",
    body: over.body ?? "Move the **storm cue** to 47.",
    body_text: over.body_text ?? "Move the storm cue to 47.",
    received_at: new Date("2026-09-04T06:00:00Z"),
    pinned_at: over.pinned_at === undefined ? null : over.pinned_at,
    frames: over.frames ?? [],
  };
}

function source(over: RowOver = {}, threadReplied = false): MailboxSyncSource {
  return { letter: mkRow(over), threadReplied };
}

describe.skipIf(!SIDECAR_UP)("the IMAP writer (integration)", () => {
  let opts: ReturnType<typeof parseImapUrl>;

  beforeAll(() => {
    opts = {
      ...parseImapUrl(IMAP_URL),
      // The dev sidecar serves a self-signed cert (bootstrap defaults).
      // Production (the homelab container) configures the CA via IMAP_URL's
      // tls passthrough — the adapter never relaxes verification itself.
      tls: { rejectUnauthorized: false },
    };
  });

  /** Reset the house's own test letters before each run. The writer is
   *  deliberately add-only in v1 (`\Deleted`+EXPUNGE is the postponed
   *  explicit-deletion slice), so the TEST harness cleans — it deletes the
   *  letters we are about to assert on, by house Message-ID, so re-runs
   *  against a populated sidecar start from a known state and the
   *  `toBe(1)` assertions hold. */
  const TEST_MESSAGE_IDS = [MESSAGE_ID, PINNED_MESSAGE_ID];

  async function resetTestLetters(): Promise<void> {
    const client = new ImapFlow(opts);
    await client.connect();
    try {
      for (const folder of ["Inbox", "Archive"]) {
        const lock = await client.getMailboxLock(folder);
        try {
          const found = await client.fetchAll("1:*", { headers: ["Message-ID"], uid: true }, { uid: true });
          const toDelete = found
            .filter((m) => TEST_MESSAGE_IDS.some((id) => (m.headers?.toString("utf-8") ?? "").includes(id)))
            .map((m) => m.uid);
          if (toDelete.length) {
            // messageDelete is EXPUNGE in imapflow — real deletion, so
            // re-runs start from a known state.
            await client.messageDelete(toDelete, { uid: true });
          }
        } finally {
          lock.release();
        }
      }
    } finally {
      await client.logout();
    }
  }

  beforeAll(async () => {
    if (INTEGRATION) {
      await resetTestLetters();
    }
  });

  /** Count messages in a folder that carry the house Message-ID. Scan +
   *  match client-side (SEARCH on headers is not a Stalwart guarantee) —
   *  never absolute counts, so re-runs against a populated sidecar stay
   *  hermetic. */
  async function findByMessageId(
    folder: string,
    messageId: string,
    include: { flags?: boolean; source?: boolean },
  ): Promise<FetchMessageObject[]> {
    const client = new ImapFlow(opts);
    await client.connect();
    try {
      const lock = await client.getMailboxLock(folder);
      try {
        const query: { headers?: string[]; flags?: boolean; source?: boolean } = { headers: ["Message-ID"] };
        if (include.flags) query.flags = true;
        if (include.source) query.source = true;
        const messages = await client.fetchAll("1:*", query, { uid: true });
        return messages.filter((m) => (m.headers?.toString("utf-8") ?? "").includes(messageId));
      } finally {
        lock.release();
      }
    } finally {
      await client.logout();
    }
  }

  async function countByMessageId(folder: string, messageId: string): Promise<number> {
    return (await findByMessageId(folder, messageId, {})).length;
  }

  async function flagsByMessageId(folder: string, messageId: string): Promise<string[]> {
    const found = await findByMessageId(folder, messageId, { flags: true });
    if (found.length === 0) return [];
    return [...(found[0].flags ?? [])];
  }

  it("syncs a letter into the sidecar and reads it back", async () => {
    const writer: MailboxWriter = new ImapMailboxWriter(opts, silentLogger());
    const sync = new MailboxSync({
      visibleLetters: async () => [source()],
      write: writer,
      log: silentLogger(),
    });

    // The letter is addressed TO hermes@house, FROM you@house — resident
    // hermes@house is a recipient, not the writer → the letter lands in
    // Inbox (plus Archive), per folderForLetter. The FIRST sync must
    // append (this run starts empty after the reset).
    const first = await sync.syncResident("hermes@house", []);
    expect(first.messages).toBeGreaterThan(0);
    expect(await countByMessageId("Inbox", MESSAGE_ID)).toBe(1);
    expect(await countByMessageId("Archive", MESSAGE_ID)).toBe(1);

    // Read the raw message back — the engine-built Message-ID and the
    // plain-text body prove the one-renderer path (append accepted the
    // RFC2822 date Stalwart parsed).
    const found = await findByMessageId("Inbox", MESSAGE_ID, { source: true });
    expect(found.length).toBe(1);
    const sourceText = found[0].source?.toString() ?? "";
    expect(sourceText).toContain(`Message-ID: ${MESSAGE_ID}`);
    expect(sourceText).toContain("Move the storm cue to 47.");
  });

  it("re-syncs idempotently — matched by Message-ID, never duplicated", async () => {
    const writer: MailboxWriter = new ImapMailboxWriter(opts, silentLogger());
    const sync = new MailboxSync({
      visibleLetters: async () => [source()],
      write: writer,
      log: silentLogger(),
    });

    await sync.syncResident("hermes@house", []);
    await sync.syncResident("hermes@house", []);

    expect(await countByMessageId("Inbox", MESSAGE_ID)).toBe(1);
    expect(await countByMessageId("Archive", MESSAGE_ID)).toBe(1);
  });

  it("carries write-only flags: pinned → \\Flagged, replied → \\Answered, never \\Seen", async () => {
    const writer: MailboxWriter = new ImapMailboxWriter(opts, silentLogger());
    const sync = new MailboxSync({
      visibleLetters: async () => [
        source(
          { id: PINNED_HASH, pinned_at: new Date("2026-09-04T07:00:00Z"), subject: "the pinned cue" },
          true, // thread replied
        ),
      ],
      write: writer,
      log: silentLogger(),
    });

    await sync.syncResident("hermes@house", []);
    const flags = await flagsByMessageId("Inbox", PINNED_MESSAGE_ID);
    expect(flags).toContain("\\Flagged");
    expect(flags).toContain("\\Answered");
    expect(flags).not.toContain("\\Seen");
  });
});
