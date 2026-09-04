/**
 * Mailbox materialisation — movement B's pure engine (SPEC §5 #12).
 *
 * The reverse translation of the SMTP door: the letter contract → IMAP's
 * fixed-shaped world (folders, UIDs, flags, headers). This module is the
 * PURE part of the mailbox sync — every mapping below is deterministic, so
 * the mailbox is a *derived view*: wiping it and re-syncing yields the same
 * UIDs, the same folders, the same messages ("wiping and re-deriving yields
 * the same rows" — the house's derivation invariant, same as clauses and
 * thread_participation).
 *
 * What this module deliberately is NOT: it has no visibility limb. It is a
 * pure transform over letters the caller has ALREADY resolved as visible to
 * the resident (the derived-participation query is the caller's — the same
 * limb the HTTP, MCP, whisper and gap faces use). The engine can never leak
 * a letter it is not handed.
 */
import type { StoredLetter } from "../types.js";
import { markdownToText } from "../pipeline/markdown.js";

/** IMAP UIDs are 32-bit: 1..4_294_967_295. */
const UID_BITS = 8; // 8 hex chars = 32 bits

/**
 * The deterministic UID for a letter: the first 32 bits of the letter's
 * sha256 id. Same letter → same UID, every sync, on any machine. The
 * sync layer (B2) asserts uniqueness within a folder; the archive itself
 * is the truth, the mailbox is a view.
 */
export function uidForLetter(id: string): number {
  return Number.parseInt(id.slice(0, UID_BITS), 16);
}

/** Mailbox folder names. Frames map to folders; Inbox/Sent/Archive are fixed. */
export type MailboxFolder = string;

export const INBOX = "Inbox";
export const SENT = "Sent";
export const ARCHIVE = "Archive";

/** A frame's folder: `name:value` (e.g. `production:tempest-tech-week`). */
export const frameFolder = (frame: string, value: string): string =>
  `${frame}:${value}`;

export interface FolderInput {
  /** The letter to place. */
  letter: Pick<StoredLetter, "envelope" | "time">;
  /** The resident the mailbox view is for. */
  resident: string;
  /**
   * Active frame folder names, most-recent first — the precedence order
   * (SPEC §5 #12: a letter appears in its most recent active frame).
   * The caller derives this per resident (frames the resident works in).
   */
  activeFrames: string[];
}

/**
 * The one folder a letter lives in OUTSIDE the archive: its most recent
 * active frame (the letter's own frame order — its plural-time statement —
 * is the "newest frame with letters" precedence; the resident's active
 * frames are only a membership test, never an ordering); else Sent (the
 * resident wrote it); else Inbox (received mail with no active frame).
 * Archive is separate — every visible letter lands there too (the caller
 * adds it).
 */
export function folderForLetter(input: FolderInput): MailboxFolder {
  const { letter, resident, activeFrames } = input;
  const active = new Set(activeFrames);
  for (const f of letter.time.frames) {
    const folder = frameFolder(f.frame, f.value);
    if (active.has(folder)) return folder;
  }
  if (letter.envelope.from === resident) return SENT;
  return INBOX;
}

/** The learning loop read back through IMAP (SPEC §5 #12, flags are the
 *  only client-writable surface). \Seen ⇄ opened, \Answered ⇄ replied,
 *  \Flagged ⇄ pinned. The caller resolves these per resident from the
 *  signal columns; the engine keeps them opaque. */
export interface MailFlagState {
  seen: boolean;
  answered: boolean;
  flagged: boolean;
}

export interface MailboxTranslationInput {
  letter: StoredLetter;
  /** The resident the mailbox view is for. */
  resident: string;
  /** Active frame folders, most-recent first (see `folderForLetter`). */
  activeFrames: string[];
  /** The learning-loop signals for THIS resident and THIS letter. */
  flags: MailFlagState;
}

/** A letter as materialised into a mailbox: a stable message in a folder. */
export interface MailboxLetter {
  /** Deterministic: first 32 bits of the letter id. */
  uid: number;
  /** One of: a frame folder, Inbox, or Sent (Archive is added by the caller). */
  folder: MailboxFolder;
  /** `<letterId@house>` — the letter's own, stable message identity. */
  messageId: string;
  /** RFC5322 Date from the gregorian timestamp. */
  date: string;
  from: string;
  to: string[];
  cc: string[];
  subject: string;
  /**
   * Synthetic threading: every message in a thread carries the thread's
   * stable reference (`<threadId@house>`), so IMAP clients group the
   * conversation the house's way without a folder per thread. Modern
   * clients thread on References; In-Reply-To is intentionally null (the
   * thread ref is not a real message's Message-ID, so replying to it
   * would dangle — References is the honest thread).
   */
  references: string[];
  inReplyTo: null;
  /** Plain text body (IMAP carries text, the archive keeps the markdown). */
  bodyText: string;
  flags: MailFlagState;
}

const ref = (id: string): string => `<${id}@house>`;

/**
 * Letter → the IMAP message shape. Pure and deterministic: the same letter
 * yields the same uid/messageId/references on every derivation, so clients
 * see a stable mailbox across resyncs. Per-resident differences (folder
 * role, flags) come from the VIEW, not the archive — the archive is one
 * truth, viewed once per resident.
 */
export function translateToMailbox(input: MailboxTranslationInput): MailboxLetter {
  const { letter, resident, activeFrames, flags } = input;
  return {
    uid: uidForLetter(letter.id ?? ""),
    folder: folderForLetter({ letter, resident, activeFrames }),
    messageId: ref(letter.id ?? ""),
    date: letter.receivedAt.toUTCString(),
    from: letter.envelope.from,
    to: [...letter.envelope.to],
    cc: [...letter.envelope.cc],
    subject: letter.envelope.subject,
    references: [ref(letter.envelope.thread)],
    inReplyTo: null,
    bodyText: markdownToText(letter.body.content),
    flags,
  };
}
