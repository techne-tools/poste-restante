export const BASE = "/v1";

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

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
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

