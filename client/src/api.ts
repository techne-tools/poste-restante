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
  kind: "house-letter" | "gap-dormant-thread" | "gap-unanswered-question";
  targetThread: string | null;
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
    throw new Error(body?.error?.message ?? `the house answered ${res.status}`);
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

  /** Threads are correspondences. */
  thread(id: string) {
    return request<{ thread: string; letters: Letter[] }>(
      `/threads/${encodeURIComponent(id)}`,
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

  /** Start the OIDC dance. Returns the provider URL to redirect to. */
  oidcStart() {
    return request<{ url: string; state: string }>("/auth/oidc/start");
  },
};
