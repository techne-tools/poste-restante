export interface OidcReturn {
  address?: string;
  token?: string;
  error?: string;
}

/**
 * Read the OIDC outcome the callback left in the URL fragment.
 *
 * The server hands the browser back to the client door with the outcome in
 * the fragment — `#oidc=<token>&address=<address>` on success, or
 * `#oidc_error=<message>` on failure. A fragment is never sent to a server;
 * the caller clears it from the address bar immediately. Returns null when
 * there is nothing to read.
 */
export function readOidcReturn(hash: string): OidcReturn | null {
  const h = hash.startsWith("#") ? hash.slice(1) : hash;
  if (!h) return null;
  const params = new URLSearchParams(h);
  const error = params.get("oidc_error");
  if (error !== null) return { error };
  const token = params.get("oidc");
  if (!token) return null;
  return { token, address: params.get("address") ?? "" };
}

export type OidcPlan =
  | { action: "none" }
  | { action: "error"; message: string }
  | { action: "signin"; address: string; header: string };

/**
 * What the door should do with the outcome it read. Pure, so the sign-in
 * decision is testable without a browser: the caller applies it — persist the
 * credential, set the session, or show the error.
 */
export function planOidcReturn(ret: OidcReturn | null): OidcPlan {
  if (!ret) return { action: "none" };
  if (ret.error) return { action: "error", message: ret.error };
  if (ret.token && ret.address) {
    return { action: "signin", address: ret.address, header: `Bearer ${ret.token}` };
  }
  return { action: "none" };
}
