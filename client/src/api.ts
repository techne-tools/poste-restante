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
  body: {
    format: "markdown";
    content: string;
  };
  receivedAt: string;
  pinnedAt: string | null;
  pinnedBy: string | null;
}

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
    | "gap-unvisited-corner";
  targetThread: string | null;
  relatedLetterId: string | null;
  /** The room in a frame-scoped gap (gap-unvisited-corner). Null otherwise. */
  targetFrame: string | null;
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

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const auth = loadAuth();
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (auth) headers.Authorization = auth.header;
  const res = await fetch(`${BASE}${path}`, {
    headers,
    ...init,
  });
  if (!res.ok) {
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

  /** Fetch one letter. */
  letter(id: string) {
    return request<Letter>(`/letters/${id}`);
  },

  /** Delete a letter — first-class, no soft delete. */
  deleteLetter(id: string) {
    return request<{ deleted: boolean; id: string }>(`/letters/${id}`, {
      method: "DELETE",
    });
  },

  /** Pin / unpin — explicit house ranking signals. */
  pin(id: string) {
    return request<{ pinned: boolean; id: string }>(`/letters/${id}/pin`, {
      method: "POST",
    });
  },

  unpin(id: string) {
    return request<{ pinned: boolean; id: string }>(`/letters/${id}/pin`, {
      method: "DELETE",
    });
  },

  /** The address book — flat, no ranking. */
  addresses() {
    return request<{ addresses: Address[] }>("/addresses");
  },

  /** The mailbox — pull by default. */
  inbox(address: string, limit = 50) {
    return request<{ address: string; letters: Letter[] }>(
      `/addresses/${encodeURIComponent(address)}/inbox?limit=${limit}`,
    );
  },

  /** Threads are correspondences. The thread is the unit, not the message.
   *  `participation` is the caller's derived state — 'in' by default; 'out'
   *  when the caller has left (leaving as first-class, the structural stop). */
  thread(id: string) {
    return request<{ thread: string; participation: "in" | "out"; letters: Letter[] }>(
      `/threads/${encodeURIComponent(id)}`,
    );
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
    return request<{ id: string; thread: string; participation: "in" | "out" }>(
      `/threads/${encodeURIComponent(id)}/join`,
      { method: "POST" },
    );
  },

  /** Frames — plural time navigation. */
  frames() {
    return request<{ frames: { id: string; name: string; value: string }[] }>("/frames");
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
