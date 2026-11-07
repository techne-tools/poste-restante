/**
 * Proof of possession for key registration — SPEC §15.
 *
 * `POST /v1/addresses/:id/keys` is self-only, so it already demands the
 * session credential. But it also writes `addresses.identity_id`, which is
 * the address's identity spine: replacing it silently re-points the letter
 * id resolver, the OIDC bindings and every signature the address will ever
 * make. A stolen bearer token must be enough to *ask*; it must not be
 * enough to replace the key.
 *
 * So a registration carries a signature, made with the NEW ed25519 private
 * key, over a server-issued nonce and the whole key record. What the house
 * learns is what an attacker with a session token and no key cannot show:
 * that whoever is registering holds the private half of the key they are
 * registering.
 *
 * Why the nonce is stateless — HMAC(secret, address, time window) — and not
 * a stored challenge row:
 *
 *   * No table, no cleanup, no schema change. The card allows a schema
 *     change only if item 2 needs one; it does not.
 *   * The security property does not rest on the nonce's secrecy. The
 *     signed message binds the address AND every key being registered, so a
 *     proof harvested from one registration cannot install *different*
 *     keys. Replaying it installs the same keys again — which
 *     `setAddressKey` already treats as a no-op.
 *   * What the window buys is freshness: a proof older than the window is
 *     refused, so a harvested signature cannot be banked indefinitely.
 *
 * The cost, stated plainly: the secret is per-process. A restart
 * invalidates outstanding challenges (the client asks for another; the
 * window is minutes), and a multi-process deployment would need the secret
 * to be configured rather than minted. The house runs as one process.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { verifySignedText } from "../crypto/keys.js";

/** The domain separator, and the first line of every signed message. It
 *  keeps a key-proof signature from being mistaken for any other use of
 *  the same key (a letter id, say). */
export const KEY_PROOF_VERSION = "poste-restante:key-proof:v1";

/** How long a challenge stands. Five minutes: long enough for a slow
 *  client to sign, short enough that a proof cannot be banked. */
export const KEY_PROOF_WINDOW_MS = 5 * 60 * 1000;

/** The public halves as they arrive in a registration. */
export interface KeyRegistration {
  ageRecipient: string;
  ed25519Public: string;
  recoveryAgeRecipient: string | null;
}

/** What the challenge endpoint hands back. */
export interface KeyChallenge {
  nonce: string;
  /** When this nonce stops being accepted (ISO-8601). */
  expiresAt: string;
}

export type KeyProofFailure = "bad_nonce" | "expired" | "bad_signature";

/**
 * The exact bytes a registration signs. Six lines, fixed order, no
 * escaping: every field is charset-constrained by the schema (bech32 and
 * base64url contain no newlines), and an absent recovery recipient is the
 * empty line. The client mirrors this function; both sides assert the same
 * literal in their tests so a drift on either side is caught.
 */
export function keyProofMessage(
  input: KeyRegistration & { address: string; nonce: string },
): string {
  return [
    KEY_PROOF_VERSION,
    input.address,
    input.nonce,
    input.ageRecipient,
    input.ed25519Public,
    input.recoveryAgeRecipient ?? "",
  ].join("\n");
}

export class KeyProofService {
  private readonly secret: Buffer;
  private readonly windowMs: number;
  private readonly now: () => number;

  constructor(opts: { secret?: Buffer; windowMs?: number; now?: () => number } = {}) {
    this.secret = opts.secret ?? randomBytes(32);
    this.windowMs = opts.windowMs ?? KEY_PROOF_WINDOW_MS;
    this.now = opts.now ?? Date.now;
  }

  private bucket(at: number): number {
    return Math.floor(at / this.windowMs);
  }

  private mac(address: string, bucket: number): string {
    return createHmac("sha256", this.secret)
      .update(`${KEY_PROOF_VERSION}\n${address}\n${bucket}`)
      .digest("base64url");
  }

  /**
   * Issue a nonce. A challenge issued moments before a window boundary is
   * still usable in the next window, so `expiresAt` names the end of the
   * second window — the latest moment `check` will accept it.
   */
  issue(address: string): KeyChallenge {
    const bucket = this.bucket(this.now());
    return {
      nonce: `${bucket}.${this.mac(address, bucket)}`,
      expiresAt: new Date((bucket + 2) * this.windowMs).toISOString(),
    };
  }

  /** Is this nonce one we issued for this address, and still in date? */
  check(address: string, nonce: string): KeyProofFailure | null {
    const separator = nonce.indexOf(".");
    if (separator <= 0) return "bad_nonce";
    const rawBucket = nonce.slice(0, separator);
    const given = nonce.slice(separator + 1);
    if (!/^\d+$/.test(rawBucket) || given.length === 0) return "bad_nonce";

    const bucket = Number(rawBucket);
    const current = this.bucket(this.now());
    // The current window and the one before it — a challenge issued a
    // second before a boundary must not expire mid-signature.
    if (bucket !== current && bucket !== current - 1) return "expired";

    const expected = Buffer.from(this.mac(address, bucket));
    const actual = Buffer.from(given);
    if (actual.length !== expected.length) return "bad_nonce";
    if (!timingSafeEqual(actual, expected)) return "bad_nonce";
    return null;
  }

  /**
   * The whole door: a nonce we issued for this address, in date, and a
   * signature over the record being installed, verified with the key the
   * record proposes. Nothing is written by this class; the caller writes
   * only after this returns ok.
   */
  verify(
    address: string,
    registration: KeyRegistration,
    nonce: string,
    signature: string,
  ):
    | { ok: true }
    | { ok: false; reason: KeyProofFailure } {
    const failure = this.check(address, nonce);
    if (failure) return { ok: false, reason: failure };
    const message = keyProofMessage({ ...registration, address, nonce });
    if (!verifySignedText(message, signature, registration.ed25519Public)) {
      return { ok: false, reason: "bad_signature" };
    }
    return { ok: true };
  }
}
