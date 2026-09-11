/**
 * The mailbox writer over a live IMAP server — movement B's live side
 * (SPEC §5 #12, build B2b). B2a built the sync state machine against an
 * interface (`MailboxWriter`); this module is the real adapter: it drives
 * imapflow against Stalwart (dev sidecar, or the `stalwartlabs/mail-server`
 * container on the target) and materialises the house's plural-time view
 * into IMAP's fixed-shape world.
 *
 * Deliberate scope lines (kept honest, same discipline as B2a):
 *   - WRITE-ONLY flags. The house carries `\Flagged` (pinned) and
 *     `\Answered` (thread replied); `\Seen` stays client-side — the
 *     read-back migration (`letter_reads`) is the POSTPONED slice. No
 *     deletion in v1 — `\Deleted`+EXPUNGE is meaningless against a
 *     re-materialised view; the explicit-deletion slice owns that. This
 *     writer is idempotent by construction: it may only add.
 *   - Idempotency rides on Message-ID, not UID. IMAP server UIDs are
 *     assigned by the sidecar and are meaningless to the house; the
 *     message's identity is B1's `Message-ID: <letterId@house>`, built
 *     into the RFC5322 headers by the engine (`toRfc5322Message`). The
 *     writer READS that id — it never derives ids from uids. A re-sync
 *     that finds the message already present is a no-op write (a second
 *     append would create a duplicate — the archive's same-letter-same-uid
 *     truth does not hold at the sidecar).
 *   - One connection per pass. `syncResident` (B2a) calls the writer once
 *     per folder; the writer connects, does its writes, closes. No
 *     long-lived connection, no IDLE (presence-not-pressure; IDLE is a
 *     client-initiated hold and is a later slice).
 */
import { ImapFlow, type ImapFlowOptions } from "imapflow";
import type { Logger } from "../pipeline/logger.js";
import type { MailboxFolder } from "./mailbox.js";
import type { FlagReadBack, MailboxWriter, Rfc5322Message } from "./sync.js";

/** Parse an imap:// URL into imapflow options — same pattern as
 *  `parseSmtpUrl` in outbound.ts: credentials ride in the URL from the
 *  environment, never in config files. */
export function parseImapUrl(url: string): ImapFlowOptions {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("invalid IMAP_URL");
  }
  if (!["imap:", "imaps:"].includes(parsed.protocol)) {
    throw new Error("IMAP_URL must be imap:// or imaps://");
  }
  const port = parsed.port
    ? Number.parseInt(parsed.port, 10)
    : parsed.protocol === "imaps:"
      ? 993
      : 143;
  const auth = {
    user: decodeURIComponent(parsed.username),
    pass: decodeURIComponent(parsed.password),
  };
  return {
    host: parsed.hostname,
    port,
    secure: parsed.protocol === "imaps:",
    auth,
  };
}

/** The B2b adapter — materialises the sync state machine's view into a
 *  live IMAP server. `upsertByUid` is a no-op when the message (matched by
 *  `Message-ID`) is already present; `ensureFolder` creates missing
 *  folders only. Idempotent: re-running a sync converges, never duplicates
 *  (IMAP server uids are NOT the house uids — the house uid lives in the
 *  Message-ID header; see module doc). */
export class ImapMailboxWriter implements MailboxWriter {
  constructor(
    private readonly options: ImapFlowOptions,
    private readonly log: Logger,
  ) {}

  /** The identity this message carries. Built by the engine (B1's
   *  `translateToMailbox` messageId = `<letterId@house>`, carried into
   *  `headers["Message-ID"]` by `toRfc5322Message`) — the writer matches
   *  and appends this id verbatim and never derives ids from numeric
   *  uids (IMAP uids are the sidecar's, meaningless to the house). */
  static messageIdOf(message: Rfc5322Message): string {
    const id = message.headers["Message-ID"];
    if (!id) throw new Error("message carries no Message-ID header");
    return id;
  }

  /** Scan a folder for the house Message-ID. Server-agnostic: SEARCH on
   *  arbitrary headers is not guaranteed (Stalwart's FTS indexes text, not
   *  headers), so existence is proven by fetching headers and matching the
   *  house Message-ID client-side. Bounded by the resident's own folder
   *  size — the house's scale, and no visibility limb (only what the
   *  caller already handed to the engine lives in these folders). */
  async existsByMessageId(
    client: ImapFlow,
    folder: MailboxFolder,
    messageId: string,
  ): Promise<boolean> {
    const lock = await client.getMailboxLock(folder);
    try {
      const messages = await client.fetchAll("1:*", { headers: ["Message-ID"] }, { uid: true });
      return messages.some((m) => {
        const head = m.headers?.toString("utf-8") ?? "";
        return head.includes(messageId);
      });
    } finally {
      lock.release();
    }
  }

  async ensureFolder(name: MailboxFolder): Promise<void> {
    if (name.toUpperCase() === "INBOX") return; // always exists
    const client = new ImapFlow(this.options);
    await client.connect();
    try {
      const folders = await client.list();
      const exists = folders.some((f) => f.path === name);
      if (!exists) {
        await client.mailboxCreate(name);
        this.log.info("mailbox:folder-created", { folder: name });
      }
    } finally {
      await client.logout();
    }
  }

  async upsertByUid(
    folder: MailboxFolder,
    uid: number,
    message: Rfc5322Message,
  ): Promise<boolean> {
    const messageId = ImapMailboxWriter.messageIdOf(message);
    const client = new ImapFlow(this.options);
    await client.connect();
    try {
      const exists = await this.existsByMessageId(client, folder, messageId);
      if (exists) return false; // converged — no-op write

      const headers = Object.entries(message.headers)
        .map(([k, v]) => `${k}: ${v}`)
        .join("\r\n");
      const source = `${headers}\r\n\r\n${message.text}\r\n`;
      await client.append(folder, Buffer.from(source, "utf-8"), message.flags, new Date(message.date));
      this.log.info("mailbox:message-appended", { folder, uid });
      return true;
    } finally {
      await client.logout();
    }
  }

  /** Pull the letter id out of a house Message-ID header value
   *  (`<a1b2c3…@house>` → `a1b2c3…`). The house's own id — the same
   *  identity B1 bakes into every mirrored message — never an IMAP uid. */
  static letterIdFromMessageId(header: string): string | null {
    const m = /^<([0-9a-f]{64})@house>$/.exec(header.trim());
    return m ? m[1]! : null;
  }

  /** Read the flags back for every mirror the house has pushed — the
   *  learning loop's other half. One connection, walk ALL folders once,
   *  merge by house letter id (the Archive copy and the frame folder copy
   *  carry the same Message-ID; either may carry the signal). Bounded by
   *  the resident's own mailbox; no visibility limb — these messages are
   *  the ones the house itself wrote for this account. */
  async readBack(): Promise<FlagReadBack[]> {
    const client = new ImapFlow(this.options);
    await client.connect();
    const merged = new Map<string, FlagReadBack>();
    try {
      const folders = await client.list();
      for (const folder of folders) {
        try {
          const lock = await client.getMailboxLock(folder.path);
          try {
            const messages = await client.fetchAll(
              "1:*",
              { headers: ["Message-ID"], flags: true },
              { uid: true },
            );
            for (const m of messages) {
              const head = m.headers?.toString("utf-8") ?? "";
              // Message-ID header line: "Message-ID: <a1b2c3…@house>"
              const line = head
                .split("\n")
                .map((l) => l.trim())
                .find((l) => l.toLowerCase().startsWith("message-id:"));
              const id = ImapMailboxWriter.letterIdFromMessageId(
                line ? line.slice("message-id:".length).trim() : "",
              );
              if (!id) continue;
              const flags = new Set<string>(m.flags ?? []);
              const prev = merged.get(id);
              merged.set(id, {
                letterId: id,
                seen: (prev?.seen ?? false) || flags.has("\\Seen"),
                answered: (prev?.answered ?? false) || flags.has("\\Answered"),
              });
            }
          } finally {
            lock.release();
          }
        } catch {
          // A folder may have been created between list and lock on a
          // busy sidecar — skip it; the next pass re-converges.
        }
      }
    } finally {
      await client.logout();
    }
    const out = [...merged.values()];
    this.log.info("mailbox:read-back", { letters: out.length });
    return out;
  }
}
