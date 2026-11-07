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
  "clause",
  "leave",
  "join",
  "agent",
  "rename",
  "shelve",
  "unshelve",
  "keyletter",
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
 * The sealed body (SPEC §15) — ciphertext the house stores but never
 * reads. The envelope keeps the pointers; the subject moves into the body
 * (the one envelope field that is pure content). The house verifies the
 * signature on ingest — the read path does not re-verify it, and this
 * comment claimed otherwise until 2026-11-07; it never embeds, FTSes, or
 * whispers sealed bodies.
 */
export interface SealedLetterBody {
  format: "sealed";
  /** The armored age ciphertext. */
  content: string;
  /** The age recipients the body was sealed to. */
  recipients: string[];
  /** ed25519 signature over the letter id, base64url. */
  signature: string;
}

/**
 * The key frame (SPEC §15, the keyletter) — a letter that carries a public
 * key, so a correspondent with an address and no keys can be made reachable
 * from inside the house rather than out of band.
 *
 * The frame is the BODY, not the envelope: the keys are content, they are
 * covered by the letter's own signature, and the archive keeps what arrived.
 * `kind: "keyletter"` is the marker a reader (and the retrieval filter) can
 * trust without parsing; the schema refuses a mismatch between kind and
 * format in either direction, so the two say the same thing or the letter is
 * refused at the door.
 *
 * The signature is over the letter ID — the id the sender hashed, made with
 * the private half of `keys.ed25519Public`. That is the whole authenticity
 * story of a keyletter: it proves the sender HOLDS the key it publishes, and
 * (because every letter face binds `from` to the authenticated caller) that
 * the address's owner sent it. It does NOT prove the address — that is what a
 * registration's challenge-response does, and why the two write paths are
 * distinguished by `address_keys.origin` and why a keyletter never pins
 * `identity_id`.
 */
export interface KeyFrameBody {
  format: "keyframe";
  /** The public key material the letter publishes. Public keys are public;
   *  the private halves never leave the sender's device. */
  keys: {
    /** The age recipient a letter is sealed to (`age1…`). */
    ageRecipient: string;
    /** The ed25519 public key (base64url SPKI) — the letter-signing key, and
     *  the one whose private half made this frame's signature. */
    ed25519Public: string;
    /** The recovery age recipient, when the sender minted one (§15 backstop). */
    recoveryAgeRecipient: string | null;
  };
  /** The human sentence that travels with the keys — the letter's own text.
   *  Readable, indexed, and the only part of a keyletter that is content. */
  content: string;
  /** ed25519 signature over the letter id, base64url. Excluded from the
   *  canonical form (the id cannot hash its own signature), exactly as the
   *  sealed body's signature is. */
  signature: string;
}

export type LetterBodyUnion = LetterBody | SealedLetterBody | KeyFrameBody;

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
  body: LetterBodyUnion;
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
