/**
 * Mailbox sync — movement B's live layer (SPEC §5 #12, build B2a).
 *
 * The sync state machine. B1 was the pure engine (uid/folder/translate);
 * B2a adds the house-side side of the mirror WITHOUT touching a Stalwart
 * sidecar: the visibility-scoped letter query, the per-resident view
 * (folder × uid × flags × body), the RFC5322 message builder (built ONCE
 * from the pure engine's MailboxLetter — one renderer, not two), and the
 * house-side flag derivation.
 *
 * Deliberate scope lines:
 *   - NO network, NO sidecar, NO imapflow. The mirror target is an
 *     interface (`MailboxWriter`); the live Stalwart+imapflow adapter is
 *     B2b, unit-tested against a fake writer the same way the pipeline
 *     tests use an in-memory repo.
 *   - NO read-back. The house records opened/replied on whispers, not
 *     letters; pins are global. A per-resident `letter_reads` migration is
 *     the read-back slice. B2a ships flags write-only (pinned → \Flagged,
 *     thread-replied → \Answered) and keeps \Seen client-side. The SPEC's
 *     "bidirectional on flags" is flagged as POSTPONED, not silently cut.
 *   - The per-resident view is scoped by the SAME derived-participation
 *     rule every house face uses. This module cannot leak a letter it is
 *     not handed.
 */
import type { Logger } from "../pipeline/logger.js";
import type { StoredLetter, LetterKind } from "../types.js";
import type { MailFlagState, MailboxFolder, MailboxLetter } from "./mailbox.js";
import { uidForLetter, translateToMailbox } from "./mailbox.js";

/** Everything the sync needs to build a resident's view. The visibility
 *  query is the CALLER's — this module only consumes already-visible rows. */
export interface MailboxSyncSource {
  /** The letter's archive row (postgres column shapes + frames). */
  letter: {
    id: string;
    from_addr: string;
    to_addrs: string[];
    cc_addrs: string[];
    thread_id: string;
    kind: string;
    lang: string;
    subject: string;
    body: string;
    body_text: string;
    received_at: Date;
    pinned_at: Date | null;
    frames: { frame: string; value: string }[];
  };
  /** Whether the letter's thread was replied to (any resident reply —
   *  the house records the strongest signal on the thread). */
  threadReplied: boolean;
}

/** The mirror target — a mailbox that can hold folders + messages. B2b
 *  adapts Stalwart/imapflow to this; unit tests use an in-memory fake. */
export interface MailboxWriter {
  /** Ensure a folder exists (idempotent). */
  ensureFolder(name: MailboxFolder): Promise<void>;
  /** Upsert a message by uid. Returns true when the message was appended. */
  upsertByUid(folder: MailboxFolder, uid: number, message: Rfc5322Message): Promise<boolean>;
}

/** An RFC5322 message the writer can materialise. Built once, from the
 *  letter — identical across folders, stable across resyncs. */
export interface Rfc5322Message {
  uid: number;
  headers: Record<string, string>;
  text: string;
  flags: string[];
  /** RFC2822 date string (e.g. "Fri, 04 Sep 2026 06:00:00 GMT"). */
  date: string;
}

/** Derive the IMAP flags the house CARRIES to the mailbox (write-only):
 *  pinned → \Flagged, thread replied → \Answered. \Seen is deliberately
 *  absent — it is the client's own, and the letter-level read-back column
 *  is the postponed slice. Keep single-source-of-truth with `toMailFlagState`. */
export function deriveMailFlags(
  letter: { pinned_at?: Date | null; pinned_by?: string | null },
  threadReplied: boolean,
): string[] {
  const flags: string[] = [];
  if (letter.pinned_at) flags.push("\\Flagged");
  if (threadReplied) flags.push("\\Answered");
  return flags;
}

/** MailFlagState → IMAP flags. Used when materialising a MailboxLetter. */
export function flagsToImap(flags: MailFlagState): string[] {
  const out: string[] = [];
  if (flags.flagged) out.push("\\Flagged");
  if (flags.answered) out.push("\\Answered");
  if (flags.seen) out.push("\\Seen");
  return out;
}

/** The same truth as `deriveMailFlags`, in the pure engine's shape. */
export function toMailFlagState(
  letter: { pinned_at?: Date | null },
  threadReplied: boolean,
): MailFlagState {
  return {
    seen: false, // read-back is the postponed slice; \Seen stays client-side
    answered: threadReplied,
    flagged: Boolean(letter.pinned_at),
  };
}

export interface MailboxViewInput {
  /** The resident the view is for. */
  resident: string;
  /** Active frame folders, most-recent first (see `folderForLetter`). */
  activeFrames: string[];
}

/** Build the complete per-resident mailbox view from already-visible
 *  letters: every letter lands in its folder (frame/Sent/Inbox) AND
 *  Archive; the Archive copy carries the same uid/messageId (the archive
 *  is one truth; the mailbox duplicates it across folders because that is
 *  the house's plural-time truth wearing IMAP's clothes). */
export function buildMailboxView(
  rows: MailboxSyncSource[],
  input: MailboxViewInput,
): Map<MailboxFolder, MailboxLetter[]> {
  const byFolder = new Map<MailboxFolder, MailboxLetter[]>();
  const push = (folder: MailboxFolder, letter: MailboxLetter) => {
    const list = byFolder.get(folder) ?? [];
    list.push(letter);
    byFolder.set(folder, list);
  };
  for (const { letter, threadReplied } of rows) {
    const mailbox = translateToMailbox({
      letter: toStored(letter),
      resident: input.resident,
      activeFrames: input.activeFrames,
      flags: toMailFlagState(letter, threadReplied),
    });
    push(mailbox.folder, mailbox);
    // Folder placement via the pure engine uses the letter's own frames;
    // Archive is the caller-composed constant — every visible letter lands
    // here too (SPEC §5 #12).
    push("Archive", mailbox);
  }
  return byFolder;
}

/** Row → the domain letter shape the pure engine consumes. */
function toStored(
  letter: MailboxSyncSource["letter"],
): StoredLetter {
  return {
    id: letter.id,
    envelope: {
      from: letter.from_addr,
      to: letter.to_addrs,
      cc: letter.cc_addrs,
      thread: letter.thread_id,
      kind: letter.kind as LetterKind,
      lang: letter.lang,
      subject: letter.subject,
    },
    time: { gregorian: letter.received_at.toISOString(), frames: letter.frames },
    body: { format: "markdown", content: letter.body },
    receivedAt: letter.received_at,
    bodyText: letter.body_text,
  };
}

/** Build an RFC5322 message (for a mailbox writer) from the pure engine's
 *  MailboxLetter — one renderer: B1 translates letter → MailboxLetter, the
 *  writer receives that shape verbatim. No second translation path. */
export function toRfc5322Message(m: MailboxLetter): Rfc5322Message {
  return {
    uid: m.uid,
    headers: {
      "Message-ID": m.messageId,
      References: m.references.join(", "),
      Subject: m.subject,
      From: m.from,
      To: m.to.join(", "),
      Cc: m.cc.join(", "),
      Date: m.date,
    },
    text: m.bodyText,
    flags: flagsToImap(m.flags),
    date: m.date,
  };
}

/** A tiny state machine over a single mailbox sync pass. The engine does
 *  the derivation; the caller supplies the source rows + the writer. This
 *  is the seam B2b's live adapter (and the integration test) drives. */
export class MailboxSync {
  constructor(
    private readonly source: {
      visibleLetters(resident: string): Promise<MailboxSyncSource[]>;
      write: MailboxWriter;
      log: Logger;
    },
  ) {}

  /** Re-sync a resident's whole view: ensure folders, upsert every message
   *  (idempotent — same uid → no-op write). Returns counts for logging
   *  (event names + counts only, never addresses or bodies). */
  async syncResident(
    resident: string,
    activeFrames: string[],
  ): Promise<{ folders: number; messages: number }> {
    const rows = await this.source.visibleLetters(resident);
    const view = buildMailboxView(rows, { resident, activeFrames });
    const folders = new Set(view.keys());
    // The archive folder must exist even when empty (the mailbox shape is
    // stable across resyncs).
    folders.add("Archive");
    let messages = 0;
    for (const folder of folders) {
      await this.source.write.ensureFolder(folder);
      for (const m of view.get(folder) ?? []) {
        await this.source.write.upsertByUid(folder, m.uid, toRfc5322Message(m));
        messages += 1;
      }
    }
    this.source.log.info("mailbox:sync-resident", {
      folders: folders.size,
      messages,
    });
    return { folders: folders.size, messages };
  }
}

/** Re-export for callers that build writers: the uid derivation stays
 *  single-sourced from B1. */
export { uidForLetter };
