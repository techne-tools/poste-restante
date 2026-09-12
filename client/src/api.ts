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
  /** True when the address is an agent — an instrument, not a person
   *  (SPEC §16). Shown flat in the book, marked as such. */
  isAgent: boolean;
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

const BASE = "/v1";

// The authenticated address, set by the login view. Persisted in
// localStorage so a refresh keeps the session (the house is stateless; the
// credential lives with the client, never with the house).
const AUTH_KEY = "poste-restante.auth";

export interface AuthState {
  address: string;
  /** The Authorization header value, e.g. "Basic …" or "Bearer …". */
  header: string;
}

export function loadAuth(): AuthState | null {
  try {
    const raw = localStorage.getItem(AUTH_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as AuthState;
    if (!parsed.address || !parsed.header) return null;
    return parsed;
  } catch {
    return null;
  }
}

export function saveAuth(state: AuthState): void {
  localStorage.setItem(AUTH_KEY, JSON.stringify(state));
}

export function clearAuth(): void {
  localStorage.removeItem(AUTH_KEY);
}

/** A dead credential is keyless. The house answered 401 — the stored
 *  session is no longer a session. Clear it and signal the door so the
 *  client returns to Login instead of sitting in a shell the house does
 *  not recognise (a rotated or removed credential must not leave the
 *  resident surface standing). */
function signalUnauthorized(): void {
  clearAuth();
  globalThis.dispatchEvent(new Event("poste-restante:signout"));
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = loadAuth();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth.header;
  const res = await fetch(`${BASE}${path}`, {
    headers,
    ...init,
  });
  if (!res.ok) {
    // A 401 with a credential attached means the credential is dead —
    // clear it and signal the door. A 401 without one (the guest reading
    // the pub while its door is closed) is the house answering "not for
    // you" — the caller (Pub) handles that itself; no session to clear.
    if (res.status === 401 && auth) signalUnauthorized();
    const body = (await res.json().catch(() => null)) as
      | { error?: { message?: string } }
      | null;
    const message = body?.error?.message ?? `the house answered ${res.status}`;
    const err = new Error(message) as Error & { status?: number };
    // The status lets callers tell one silence from another — a closed pub
    // door (401) from a broken house (5xx). Absence is silence; the kind
    // of absence is still a fact worth knowing in the room that asks.
    err.status = res.status;
    throw err;
  }
  return res.json() as Promise<T>;
}

export const house = {
  /** Deliver a letter. Idempotent. */
  deliver(letter: Omit<Letter, "id" | "receivedAt" | "pinnedAt" | "pinnedBy">) {
    return request<{ id: string; created: boolean }>("/letters", {
      method: "POST",
      body: JSON.stringify(letter),
    });
  },

  /** Search — exact + FTS + semantic, merged by RRF. */
  search(params: Record<string, string> = {}) {
    const qs = new URLSearchParams(params).toString();
    return request<SearchResponse>(`/letters${qs ? `?${qs}` : ""}`);
  },

  /** Delete a letter — first-class, no soft delete. */
  deleteLetter(id: string) {
    return request<{ deleted: boolean; id: string }>(`/letters/${id}`, {
      method: "DELETE",
    });
  },

  /** The payload catalog — what a letter carries beyond its body. */
  payloads(letterId: string) {
    return request<{ letterId: string; payloads: PayloadMeta[] }>(
      `/letters/${encodeURIComponent(letterId)}/payloads`,
    );
  },

  /** Upload a raw payload — an enclosure for a letter already delivered.
   *  The bytes travel raw (no JSON wrapping); the name and content type
   *  ride in headers so the house can catalogue them (migration 016). */
  uploadPayload(letterId: string, file: Blob, name: string) {
    return request<{ letterId: string; key: string; name: string; size: number }>(
      `/letters/${encodeURIComponent(letterId)}/payloads`,
      {
        method: "POST",
        headers: {
          "Content-Type": file.type || "application/octet-stream",
          "X-Payload-Name": name,
        },
        body: file,
      },
    );
  },

  /** Fetch an enclosure's bytes as a blob, with the house's auth on the
   *  request. Plain <img>/<audio> tags cannot carry the Authorization
   *  header from storage, so the client fetches once and hands the renderer
   *  an object URL (revoked by the caller after the element unmounts). */
  async payloadBlob(letterId: string, name: string): Promise<Blob> {
    const auth = loadAuth();
    const headers: Record<string, string> = {};
    if (auth) headers.Authorization = auth.header;
    const res = await fetch(
      `${BASE}/letters/${encodeURIComponent(letterId)}/payloads/${encodeURIComponent(name)}`,
      { headers },
    );
    if (!res.ok) {
      throw new Error(`the house could not open ${name}`);
    }
    return res.blob();
  },

  /** Delete an enclosure — the bytes and the catalog row. */
  deletePayload(letterId: string, name: string) {
    return request<{ deleted: boolean; key: string }>(
      `/letters/${encodeURIComponent(letterId)}/payloads/${encodeURIComponent(name)}`,
      { method: "DELETE" },
    );
  },

  /** The address book — flat, no ranking. */
  addresses() {
    return request<{ addresses: Address[] }>("/addresses");
  },

  /** One address — the resident's own record, by handle. */
  address(id: string) {
    return request<Address & { is_public: boolean }>(`/addresses/${encodeURIComponent(id)}`);
  },

  /** Correct the address book. The house takes corrections at face value.
   *  Only the address itself may correct its own entry. */
  correctAddress(id: string, names: string[], pronouns: string | null) {
    return request<Address & { is_public: boolean }>(`/addresses/${encodeURIComponent(id)}`, {
      method: "PATCH",
      body: JSON.stringify({ names, pronouns }),
    });
  },

  /** Register the public halves of a resident's keypairs (SPEC §15). The
   *  private halves are client-held — the house never holds a private
   *  key. Public keys are public; from this moment the ed25519
   *  fingerprint is the identity the letter id resolver uses. */
  registerKeys(
    id: string,
    keys: { ageRecipient: string; ed25519Public: string; recoveryAgeRecipient?: string | null },
  ) {
    return request<{
      address?: string;
      age_recipient: string;
      ed25519_public: string;
      recovery_age_recipient: string | null;
    }>(`/addresses/${encodeURIComponent(id)}/keys`, {
      method: "POST",
      body: JSON.stringify(keys),
    });
  },

  /** Relabel — the handle is a label, the identity is the key (SPEC §19). */
  relabel(id: string, handle: string) {
    return request<{ relabeled: boolean; from: string; to: string }>(
      `/addresses/${encodeURIComponent(id)}/relabel`,
      { method: "POST", body: JSON.stringify({ handle }) },
    );
  },

  /** Change the password — the resident's own door. The house never
   *  resets anyone; it only changes when the caller proves possession of
   *  the current credential. A wrong current answers 401 — the door's
   *  silence. The saved session dies (the stored Basic header is built
   *  from the old secret); the resident signs in again under the new
   *  one. */
  changePassword(id: string, current: string, next: string) {
    return request<{ changed: boolean; address: string }>(
      `/addresses/${encodeURIComponent(id)}/password`,
      { method: "POST", body: JSON.stringify({ current, next }) },
    );
  },

  /** The house's own words — the serif voice's names for the rooms. */
  houseMeta() {
    return request<HouseMeta>("/house/meta");
  },

  /** The mailbox — pull by default. */
  inbox(address: string, limit = 50) {
    return request<{ address: string; letters: Letter[] }>(
      `/addresses/${encodeURIComponent(address)}/inbox?limit=${limit}`,
    );
  },

  /** Threads are correspondences. The thread is the unit, not the message.
   *  `participation` is the caller's derived state — 'in' by default; 'out'
   *  when the caller has left (leaving as first-class, the structural stop);
   *  'shelved' when the caller has put it away (the shelf, migration 025 —
   *  the edges stand, but the mailbox and the whisper stop offering it). */
  thread(id: string) {
    return request<{
      thread: string;
      participation: "in" | "out" | "shelved";
      letters: Letter[];
    }>(`/threads/${encodeURIComponent(id)}`);
  },

  /** Leave a thread — the structural stop. The act IS a letter; the archive
   *  keeps the history; participation is derived. The leaver's edges
   *  dissolve — visibility prunes itself. Symmetric by construction. */
  leaveThread(id: string) {
    return request<{ id: string; thread: string; participation: "in" | "out" }>(
      `/threads/${encodeURIComponent(id)}/leave`,
      { method: "POST" },
    );
  },

  /** Rejoin a thread — the historical edges stand again. */
  joinThread(id: string) {
    return request<{ id: string; thread: string; participation: "in" | "out" | "shelved" }>(
      `/threads/${encodeURIComponent(id)}/join`,
      { method: "POST" },
    );
  },

  /** Put a thread away — the resident's own shelf. The edges stand, the
   *  thread stays readable; the mailbox and the whisper stop offering it.
   *  Bring it back with unshelveThread. */
  shelveThread(id: string) {
    return request<{ id: string; thread: string; participation: "out" | "shelved" }>(
      `/threads/${encodeURIComponent(id)}/shelve`,
      { method: "POST" },
    );
  },

  /** Bring a thread back from the shelf — the edges stood the whole time. */
  unshelveThread(id: string) {
    return request<{ id: string; thread: string; participation: "in" | "shelved" }>(
      `/threads/${encodeURIComponent(id)}/unshelve`,
      { method: "POST" },
    );
  },

  /** Scrub a thread — the safety move (SPEC §19). Deletes every letter the
   *  caller is party to in the thread, plus the thread, payloads, qdrant
   *  points, and whispers pointing at it. Unilateral and immediate. The
   *  other party's letters stay; the caller's view of the thread is gone. */
  scrubThread(id: string) {
    return request<{ scrubbed: boolean; thread: string; deleted: number }>(
      `/threads/${encodeURIComponent(id)}/scrub`,
      { method: "POST" },
    );
  },

  /** Frames — plural time navigation. */
  frames() {
    return request<{ frames: { id: string; name: string; value: string }[] }>("/frames");
  },

  /** The day — the callsheet whiteboard (SPEC §18). A thin derived view:
   *  letters in the resident's visible frames, their instruments alive in
   *  those frames, the whisper's current offers, the book's standing
   *  clauses. Derived, never stored. The board shows only what the
   *  resident is party to. Presence not pressure. */
  day() {
    return request<DayProjection>("/day");
  },

  /** The whisper — the house's own letters. Pull-only. */
  whisper(unread = false) {
    return request<{ whispers: Whisper[] }>(`/whisper${unread ? "?unread=1" : ""}`);
  },

  openWhisper(id: string) {
    return request<{ opened: boolean; id: string }>(`/whisper/${id}/open`, {
      method: "POST",
    });
  },

  dismissWhisper(id: string) {
    return request<{ dismissed: boolean; id: string }>(`/whisper/${id}/dismiss`, {
      method: "POST",
    });
  },

  undismissWhisper(id: string) {
    return request<{ dismissed: boolean; id: string }>(`/whisper/${id}/undismiss`, {
      method: "POST",
    });
  },

  /** Gap detection — cheap structural checks, on demand. */
  detectGaps() {
    return request<{ created: string[] }>("/whisper/gaps", { method: "POST" });
  },

  /** The house book — the derived constitution. Commons by right. */
  book() {
    return request<BookHead>("/book");
  },

  /** Read one clause thread — the correspondence is the develop. */
  clauseThread(thread: string) {
    return request<{ thread: string; letters: Letter[] }>(
      `/book/threads/${encodeURIComponent(thread)}`,
    );
  },

  /** Perform an act on the book — the act IS a letter. */
  actOnBook(action: {
    role: ClauseRole;
    continues?: string;
    reverses?: string;
    binding?: { door: string; value: boolean };
    text?: string;
  }) {
    return request<{ id: string; clause: Clause }>("/book", {
      method: "POST",
      body: JSON.stringify(action),
    });
  },

  /** Start the OIDC dance. Returns the provider URL to redirect to. */
  oidcStart() {
    return request<{ url: string; state: string }>("/auth/oidc/start");
  },

  /**
   * Redeem an invitation — the guest's door. Public like OIDC: the caller
   * has no credential yet, so the Authorization header (if any) is never
   * attached — the guest redeems as themselves, not as a stale resident.
   * Proves possession of the invite letter and the one-time code; the house
   * answers 201 {address, joined} or, on every negative path (wrong code,
   * spent, expired, wrong address), the same 404 — absence is silence.
   */
  async redeemInvite(input: {
    address: string;
    code: string;
    password: string;
  }): Promise<{ address: string; joined: boolean }> {
    const res = await fetch(`${BASE}/invites/redeem`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    if (!res.ok) {
      throw new Error("the house has no invitation for you — check the code and address");
    }
    return res.json() as Promise<{ address: string; joined: boolean }>;
  },
};
