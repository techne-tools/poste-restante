/**
 * The session's unsealed-letter cache — PLAN-crypto.md E4.
 *
 * Decrypting a sealed body is not free, and a thread view re-renders: the
 * same letter can reach for its plaintext many times per reading. Without a
 * cache, every one of those passes pays for a full age decrypt.
 *
 * The key is (letter id, the resident's key fingerprint). The letter id is a
 * hash of the letter, so it identifies an immutable thing; the fingerprint is
 * the resident's CURRENT key generation, so re-keying the resident cannot be
 * served an answer the old key produced.
 *
 * What is cached is plaintext, in memory only. It is never written to
 * storage. There is exactly one event that must empty it — locking the
 * keystore — and `keystore.ts` calls forgetUnsealed() on every lock and wipe
 * path, so a locked client holds no unsealed letter, here or in the vault.
 *
 * Failures are cached too, except `no_keys`: that one is a fact about the
 * keystore, not about the letter, and it becomes false the moment the
 * resident opens the keystore. Caching it would give the reader a stale
 * "locked" on a letter that has just become readable.
 */

/** What an unseal attempt can say — the shape `crypto.ts` returns. */
export type UnsealedResult =
  | { ok: true; plaintext: string }
  | { ok: false; reason: "no_keys" | "not_recipient" | "failed" };

/** How many letters one session keeps open. Enough for a thread being read,
 *  small enough that a long session does not accumulate an archive of
 *  plaintext in memory. Oldest entries fall out first. */
const MAX_ENTRIES = 64;

const cache = new Map<string, UnsealedResult>();

function cacheKey(letterId: string, fingerprint: string): string {
  // The separator cannot occur in either part (hex id, base64url key).
  return `${letterId}\u0000${fingerprint}`;
}

/** The cached outcome for this letter under this key generation, or
 *  undefined when it has not been tried. */
export function cachedUnseal(
  letterId: string,
  fingerprint: string,
): UnsealedResult | undefined {
  return cache.get(cacheKey(letterId, fingerprint));
}

/** Remember an unseal outcome. A `no_keys` answer is not a property of the
 *  letter and is never stored. */
export function cacheUnseal(
  letterId: string,
  fingerprint: string,
  result: UnsealedResult,
): void {
  if (!result.ok && result.reason === "no_keys") return;
  const key = cacheKey(letterId, fingerprint);
  // Re-insertion moves an entry to the young end: a letter being read stays.
  cache.delete(key);
  cache.set(key, result);
  while (cache.size > MAX_ENTRIES) {
    const oldest = cache.keys().next().value;
    if (oldest === undefined) break;
    cache.delete(oldest);
  }
}

/** Empty the cache. Called on lock, on wipe, and on sign-out — anywhere the
 *  resident's keys stop being open. */
export function forgetUnsealed(): void {
  cache.clear();
}
