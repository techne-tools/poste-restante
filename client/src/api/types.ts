/**
 * The house's protocol, as a client. Every address is a resource; delivery is
 * a POST; the mailbox is a GET. Pull by default — nothing pushes.
 */

export interface Frame {
  frame: string;
  value: string;
}

export interface Letter {
  id: string;
  envelope: {
    from: string;
    to: string[];
    cc: string[];
    thread: string;
    kind: string;
    lang: string;
    subject: string;
  };
  time: {
    gregorian: string;
    frames: Frame[];
  };
  body: LetterBody;
  receivedAt: string;
  pinnedAt: string | null;
  pinnedBy: string | null;
}

/** The letter's body — markdown, or sealed ciphertext (SPEC §15). The
 *  house stores sealed bodies without reading them; the reader unseals
 *  with their own key. */
export type LetterBody =
  | {
      format: "markdown";
      content: string;
    }
  | {
      format: "sealed";
      /** The armored age ciphertext. The house stores it, never reads it. */
      content: string;
      /** The age recipients sealed to. Empty when served back (the house
       *  stores the ciphertext, never the recipient list — data
       *  minimisation; the reader needs only their own key). */
      recipients: string[];
      /** ed25519 signature over the letter id, base64url. */
      signature: string;
    };

export interface Whisper {
  id: string;
  letterId: string | null;
  kind:
    | "house-letter"
    | "gap-dormant-thread"
    | "gap-unanswered-question"
    | "gap-contradiction"
    | "gap-uncited-connection"
    | "gap-echo"
    | "gap-unvisited-corner"
    | "door-knock";
  targetThread: string | null;
  relatedLetterId: string | null;
  /** The room in a frame-scoped gap (gap-unvisited-corner). Null otherwise. */
  targetFrame: string | null;
  /** The resident a door-knock is addressed to (door-knock). Null otherwise. */
  targetAddress: string | null;
  /** The clause the house cites — "the household has held this; want to
   *  look?" A pointer, not a verdict. Null when no citation. */
  citedClause: string | null;
  /** The cited clause's current text, truncated, so the sidebar is
   *  self-contained. Null when no citation. */
  citedExcerpt: string | null;
  summary: string;
  reasoning: string | null;
  createdAt: string;
  openedAt: string | null;
  dismissedAt: string | null;
  repliedAt: string | null;
}

export interface Address {
  id: string;
  names: string[];
  pronouns: string | null;
  /** The public halves of any registered keys (SPEC §15). Null for a
   *  legacy address without keys — the identity IS the handle until
   *  one exists. Public keys are public; the correspondence needs them
   *  to seal to this address and verify its letters. */
  ageRecipient: string | null;
  ed25519Public: string | null;
  /** The recovery age recipient (SPEC §15 backstop). Sealed to whenever
   *  present, so a correspondent whose primary key is lost can still
   *  open letters with the off-box recovery key. Null until minted. */
  recoveryAgeRecipient: string | null;
  /** True when the address is an agent — an instrument, not a person
   *  (SPEC §16). Shown flat in the book, marked as such. */
  isAgent: boolean;
  /** The desk's seal default — when this resident sits down to write, the
   *  seal is already on (absent = false, sealing stays per-letter). */
  sealDefault: boolean;
}

/** The house book — the derived constitution (SPEC §5.8). */
export interface Clause {
  thread: string;
  text: string;
  proposedBy: string;
  proposedIn: string;
  state: "proposed" | "contested" | "standing" | "reversed";
  settlingFrom: string;
  settlesAt: string;
  stoodAt: string | null;
  reversedAt: string | null;
  reversedIn: string | null;
  pendingReversal: boolean;
  reversesThread: string | null;
  objections: number;
  vouches: number;
  /** Supports that endorse the offer lineage (depth ≤ 1) — the pool that
   *  can carry the clause to standing (rule 11). */
  supportsTowardStanding: number;
  binding: { door: string; value: boolean } | null;
}

export interface BookHead {
  clauses: Clause[];
  doors: { door: string; value: boolean; boundBy: string }[];
  settlingDays: number;
}

export type ClauseRole = "offer" | "develop" | "stop" | "support" | "set aside";

/** The day's projection — the callsheet whiteboard (SPEC §18). Derived,
 *  never stored: letters in the resident's visible frames, their
 *  instruments alive in those frames, the whisper's current offers, the
 *  book's standing clauses. The board shows only what the resident is
 *  party to; presence not pressure. */
export interface DayProjection {
  /** The resident's active frames, with their letters in order. */
  frames: {
    frame: string;
    letters: {
      letterId: string;
      thread: string;
      subject: string;
      kind: string;
      from: string;
      receivedAt: string;
      frames: Frame[];
    }[];
  }[];
  /** The resident's instruments alive in those frames. */
  agents: {
    address: string;
    task: string;
    creator: string;
    lifespanFrame: string | null;
  }[];
  /** The day's cards — single items pinned to the board, scoped to the
   *  resident ('house' is every resident; 'group' is a thread's
   *  participants; 'address' is one address). Cards are single items,
   *  not threads, and never the pub — cards are household-facing.
   *  Presence not pressure — a card holds on the board, it never pings. */
  cards: {
    id: string;
    text: string;
    scope: "house" | "group" | "address";
    scopeValue: string;
    frameId: string | null;
    createdBy: string;
    createdAt: string;
  }[];
  /** The whisper's current offers — what the house is offering right now. */
  whispers: {
    id: string;
    kind: string;
    summary: string;
    targetThread: string | null;
    targetFrame: string | null;
  }[];
  /** The book's standing clauses that bear on the day. */
  clauses: { thread: string; text: string; state: string }[];
}

/** The house's own words (SPEC §5 #14) — the serif voice on the page.
 *  The addresses are protocol-stable; the names are the community's. */
export interface HouseMeta {
  houseName: string;
  pubName: string;
  bookName: string;
  mailboxName: string;
  archiveName: string;
  addressesName: string;
  profileName: string;
  writeName: string;
  whisperName: string;
  dayName: string;
  domain: string;
  /** The house's public halves (SPEC §15, second model) — the composer
   *  seals *with* the house by including house@house; the house opens
   *  only the collaborative letters it is party to. Null before the
   *  house key is provisioned. */
  houseAgeRecipient: string | null;
  houseEd25519Public: string | null;
  houseAddress: string | null;
  /** Whether the house offers a provider door — the login shows the
   *  provider button only when it does. */
  oidcEnabled: boolean;
}

export interface SearchHit {
  letterId: string;
  score: number;
  paths: string[];
  ranks: Record<string, number>;
}

export interface SearchResponse {
  hits: SearchHit[];
  letters: Letter[];
}

/** The payload catalog — what a letter carries beyond its body (migration
 *  016). The name, content type, and size ride in the list response so the
 *  client can render an enclosure without fetching bytes first; the bytes
 *  themselves stay behind the house's auth. */
export interface PayloadMeta {
  key: string;
  name: string;
  contentType: string;
  size: number;
}

