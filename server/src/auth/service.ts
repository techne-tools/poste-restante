/**
 * AuthService — the house's authentication layer.
 *
 * Identity = address. A credential is a capability to act as an address.
 * Two modes, both options:
 *
 *   * Basic  — `Authorization: Basic base64(address:password)`, scrypt-hashed
 *              (Node built-in, zero deps), stateless. No sessions, no
 *              cookies — the house holds nothing between requests.
 *   * OIDC   — the house is a Relying Party. `start` → provider →
 *              `callback` → verify id_token (JWKS) → map `sub` to address.
 *              PKCE + client_secret_post (the homelab VoidAuth pattern).
 *
 * Agents (MCP) cannot do interactive login over stdio: they authenticate
 * with an opaque bearer token issued by the CLI, stored as a sha256 hash.
 * No token → fail closed.
 *
 * Privacy as schema: only a hash is ever stored. The house never holds a
 * password, a token, or an id_token.
 */
import { createHash, randomBytes, scryptSync, timingSafeEqual } from "node:crypto";
import { createRemoteJWKSet, jwtVerify } from "jose";
import type pg from "pg";
import type { Logger } from "../pipeline/logger.js";

export interface OidcConfig {
  /** The provider's issuer URL, e.g. https://auth.example.com. */
  issuer: string;
  /** This house's client id at the provider. */
  clientId: string;
  /** This house's client secret at the provider. */
  clientSecret: string;
  /** The redirect URI the provider sends the user back to. */
  redirectUri: string;
  /** The address that owns the house (used for the OIDC bootstrap claim). */
  ownerAddress: string;
}

export interface AuthConfig {
  /** 'basic' | 'oidc' | 'both' | 'none' (none = development only). */
  mode: "basic" | "oidc" | "both" | "none";
  oidc?: OidcConfig;
}

export interface Authenticated {
  /** The address the credential acts as. */
  address: string;
  /** How the address authenticated. */
  method: "password" | "token" | "oidc";
}

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

/** Hash a password with scrypt. Format: scrypt$N$r$p$salt$hash (hex). */
export function hashPassword(password: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_R,
    p: SCRYPT_P,
  });
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt.toString("hex")}$${hash.toString("hex")}`;
}

/** Verify a password against a stored scrypt hash. */
export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;
  const [, nStr, rStr, pStr, saltHex, hashHex] = parts;
  if (!nStr || !rStr || !pStr || !saltHex || !hashHex) return false;
  const n = Number.parseInt(nStr, 10);
  const r = Number.parseInt(rStr, 10);
  const p = Number.parseInt(pStr, 10);
  const salt = Buffer.from(saltHex, "hex");
  const expected = Buffer.from(hashHex, "hex");
  const actual = scryptSync(password, salt, expected.length, { N: n, r, p });
  return timingSafeEqual(actual, expected);
}

/** Hash an opaque bearer token (sha256 hex). The token itself is never stored. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** Generate an opaque bearer token. Shown once at issue time. */
export function generateToken(): string {
  return `pr_${randomBytes(32).toString("base64url")}`;
}

export class AuthService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly log: Logger,
    private readonly config: AuthConfig,
  ) {}

  /** Whether authentication is required at all. */
  get enabled(): boolean {
    return this.config.mode !== "none";
  }

  /** Whether the given address has any credential. */
  async hasCredential(address: string): Promise<boolean> {
    const { rows } = await this.pool.query(
      "SELECT 1 FROM credentials WHERE address = $1",
      [address],
    );
    return rows.length > 0;
  }

  /** Set a password credential for an address (idempotent upsert). */
  async setPassword(address: string, password: string): Promise<void> {
    await this.ensureAddress(address);
    await this.pool.query(
      `INSERT INTO credentials (address, kind, secret)
       VALUES ($1, 'password', $2)
       ON CONFLICT (address) DO UPDATE SET kind = 'password', secret = $2`,
      [address, hashPassword(password)],
    );
  }

  /** Issue a bearer token for an address. Returns the token — shown once. */
  async issueToken(address: string): Promise<string> {
    await this.ensureAddress(address);
    const token = generateToken();
    await this.pool.query(
      `INSERT INTO credentials (address, kind, secret)
       VALUES ($1, 'token', $2)
       ON CONFLICT (address) DO UPDATE SET kind = 'token', secret = $2`,
      [address, hashToken(token)],
    );
    return token;
  }

  /** Bind an OIDC subject to an address (the claim step of first login). */
  async bindOidc(address: string, sub: string): Promise<void> {
    await this.ensureAddress(address);
    await this.pool.query(
      `INSERT INTO credentials (address, kind, secret, oidc_sub)
       VALUES ($1, 'oidc', '', $2)
       ON CONFLICT (address) DO UPDATE SET oidc_sub = $2`,
      [address, sub],
    );
  }

  /**
   * A credential is a capability to act as an address — issuing one makes the
   * address a resident. The address must exist in the social graph first
   * (credentials.address references addresses.id), so the owner's CLI creates
   * it as part of the act. Idempotent: the address may already exist.
   */
  private async ensureAddress(address: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO addresses (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
      [address],
    );
  }

  /** Remove a credential. The address remains in the social graph. */
  async removeCredential(address: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM credentials WHERE address = $1", [address]);
    return (res.rowCount ?? 0) > 0;
  }

  /** List addresses that have credentials (the residents who can act). */
  async listCredentials(): Promise<{ address: string; kind: string; oidcSub: string | null }[]> {
    const { rows } = await this.pool.query(
      `SELECT address, kind, oidc_sub AS "oidcSub" FROM credentials ORDER BY address`,
    );
    return rows;
  }

  /**
   * Authenticate a request. Returns the address, or null when the request is
   * not authenticated. Never throws for a bad credential — it returns null
   * and the caller decides (404, not 403: absence is silence).
   */
  async authenticate(
    authorization: string | undefined,
  ): Promise<Authenticated | null> {
    if (!authorization) return null;

    const [scheme, value] = authorization.split(" ");
    if (!scheme || !value) return null;

    if (scheme.toLowerCase() === "basic") {
      if (this.config.mode !== "basic" && this.config.mode !== "both") return null;
      return this.authenticateBasic(value);
    }

    if (scheme.toLowerCase() === "bearer") {
      return this.authenticateToken(value);
    }

    return null;
  }

  private async authenticateBasic(encoded: string): Promise<Authenticated | null> {
    let decoded: string;
    try {
      decoded = Buffer.from(encoded, "base64").toString("utf8");
    } catch {
      return null;
    }
    const idx = decoded.indexOf(":");
    if (idx < 0) return null;
    const address = decoded.slice(0, idx);
    const password = decoded.slice(idx + 1);

    const { rows } = await this.pool.query<{ secret: string }>(
      `SELECT secret FROM credentials WHERE address = $1 AND kind = 'password'`,
      [address],
    );
    const row = rows[0];
    if (!row) return null;
    if (!verifyPassword(password, row.secret)) return null;

    await this.touch(address);
    return { address, method: "password" };
  }

  private async authenticateToken(token: string): Promise<Authenticated | null> {
    const { rows } = await this.pool.query<{ address: string }>(
      `SELECT address FROM credentials WHERE kind = 'token' AND secret = $1`,
      [hashToken(token)],
    );
    const row = rows[0];
    if (!row) return null;
    await this.touch(row.address);
    return { address: row.address, method: "token" };
  }

  private async touch(address: string): Promise<void> {
    await this.pool.query(
      "UPDATE credentials SET last_used_at = now() WHERE address = $1",
      [address],
    );
  }

  // ── OIDC ────────────────────────────────────────────────────────────────────

  /** Whether OIDC is configured. */
  get oidcEnabled(): boolean {
    return Boolean(this.config.oidc) && (this.config.mode === "oidc" || this.config.mode === "both");
  }

  /**
   * Build the OIDC authorization URL (authorization code + PKCE).
   * Returns the URL and the PKCE verifier (the house must remember it for
   * the callback — held in memory, never persisted).
   */
  async oidcStart(): Promise<{ url: string; verifier: string; state: string }> {
    if (!this.config.oidc) throw new Error("OIDC is not configured");
    const { issuer, clientId, redirectUri } = this.config.oidc;

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const state = randomBytes(16).toString("base64url");

    const discovery = await this.oidcDiscovery(issuer);
    const params = new URLSearchParams({
      response_type: "code",
      client_id: clientId,
      redirect_uri: redirectUri,
      scope: "openid profile email",
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
    });
    return { url: `${discovery.authorization_endpoint}?${params.toString()}`, verifier, state };
  }

  /**
   * Exchange the authorization code for tokens, verify the id_token, and
   * resolve the address. Returns the address and the OIDC subject.
   */
  async oidcCallback(
    code: string,
    verifier: string,
  ): Promise<{ address: string; sub: string }> {
    if (!this.config.oidc) throw new Error("OIDC is not configured");
    const { issuer, clientId, clientSecret, redirectUri, ownerAddress } = this.config.oidc;

    const discovery = await this.oidcDiscovery(issuer);

    // Token exchange — client_secret_post (the VoidAuth homelab pattern).
    const tokenRes = await fetch(discovery.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        client_id: clientId,
        client_secret: clientSecret,
        code_verifier: verifier,
      }),
    });
    if (!tokenRes.ok) {
      const detail = await tokenRes.text().catch(() => "");
      throw new Error(`OIDC token exchange failed: ${tokenRes.status} ${detail.slice(0, 200)}`);
    }
    const tokens = (await tokenRes.json()) as { id_token?: string };
    if (!tokens.id_token) throw new Error("OIDC token exchange returned no id_token");

    // Verify the id_token against the provider's JWKS.
    const jwks = createRemoteJWKSet(new URL(discovery.jwks_uri));
    const { payload } = await jwtVerify(tokens.id_token, jwks, {
      issuer,
      audience: clientId,
    });
    const sub = payload.sub;
    if (!sub) throw new Error("OIDC id_token has no subject");

    // Resolve the address: an existing credential binding, or the owner
    // claiming the house on first login.
    const { rows } = await this.pool.query<{ address: string }>(
      `SELECT address FROM credentials WHERE oidc_sub = $1`,
      [sub],
    );
    const bound = rows[0];
    if (bound) {
      await this.touch(bound.address);
      return { address: bound.address, sub };
    }

    // First login: only the owner address may claim the house.
    if (ownerAddress) {
      const existing = await this.hasCredential(ownerAddress);
      if (!existing) {
        await this.bindOidc(ownerAddress, sub);
        return { address: ownerAddress, sub };
      }
    }

    throw new Error("this identity is not a resident of the house");
  }

  private async oidcDiscovery(issuer: string): Promise<{
    authorization_endpoint: string;
    token_endpoint: string;
    jwks_uri: string;
  }> {
    const res = await fetch(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`);
    if (!res.ok) throw new Error(`OIDC discovery failed: ${res.status}`);
    const doc = (await res.json()) as {
      authorization_endpoint: string;
      token_endpoint: string;
      jwks_uri: string;
    };
    return doc;
  }
}
