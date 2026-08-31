/**
 * The letter — the unit of the house. Envelope + body. That's the whole protocol.
 *
 * Mirrors CONTRACT.md §The Letter. The envelope has exactly the fields a letter
 * needs for delivery; nothing collectable that isn't required.
 */

/** The kinds of letter. A letter is one of these. */
export const LETTER_KINDS = [
  "letter",
  "feed",
  "system",
  "audio",
  "note",
  "task",
  "invite",
] as const;

export type LetterKind = (typeof LETTER_KINDS)[number];

/** A single temporal frame a letter lives in. Frames are the human's way in. */
export interface Frame {
  /** The frame name, e.g. `islamic`, `season`, `production`, `semester`, `run`. */
  frame: string;
  /** The value within that frame, e.g. `1448-03-15`, `autumn`, `tempest-tech-week`. */
  value: string;
}

/** The envelope — the delivery metadata. Exactly the fields a letter needs. */
export interface Envelope {
  /** The sender's address, e.g. `hermes@house`. */
  from: string;
  /** The recipients' addresses. */
  to: string[];
  /** Carbon-copy recipients. */
  cc: string[];
  /** The thread id, e.g. `th_9f2c1`. The thread is the unit, not the message. */
  thread: string;
  /** The kind of letter. */
  kind: LetterKind;
  /** The language of the letter, e.g. `en-AU`. */
  lang: string;
  /** The subject line. */
  subject: string;
}

/** Plural time. Gregorian is the index; frames are the addresses. */
export interface LetterTime {
  /** The Gregorian timestamp — the sort key, the sync cursor, the machine's spine. */
  gregorian: string;
  /** The frames the letter lives in. A letter can be in many frames. */
  frames: Frame[];
}

/** The body — the content. Markdown. */
export interface LetterBody {
  /** The body format. The house assumes markdown from day one. */
  format: "markdown";
  /** The markdown content. */
  content: string;
}

/**
 * A letter as it arrives at the house. The id is derived from the envelope +
 * body (sha256 of the canonical serialisation) — it is never supplied by the
 * sender. Optional here so a letter can be constructed without one; the
 * pipeline always derives it.
 */
export interface Letter {
  /** sha256 of the canonical envelope+body serialisation. Derived, not supplied. */
  id?: string;
  envelope: Envelope;
  time: LetterTime;
  body: LetterBody;
}

/** A letter as stored in the archive (postgres row + qdrant vector + minio file). */
export interface StoredLetter extends Letter {
  /** The gregorian timestamp as a Date (parsed from `time.gregorian`). */
  receivedAt: Date;
  /** The plain-text body, extracted from markdown for embedding and FTS. */
  bodyText: string;
}

/** A letter that has been pinned (explicit house signal for ranking). */
export interface PinnedLetter {
  letterId: string;
  /** The address that pinned it. */
  pinnedBy: string;
  /** When it was pinned. */
  pinnedAt: Date;
}
