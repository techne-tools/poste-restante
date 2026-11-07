/**
 * Letter identity — the identity-key protocol (SPEC §19).
 *
 * The id is `sha256` of the canonical serialisation of the envelope +
 * body, where the envelope's addresses are resolved to their IDENTITY
 * ids before hashing. A rename never changes a letter's id — the integrity
 * spine (dedup, references, payloads, qdrant points) holds through the
 * change.
 *
 * The identity is the address's DURABLE identity (amended 2026-11-08): the
 * ed25519 fingerprint of the first key the address ever registered, pinned
 * once and never moved. A key is material the address holds over time, so
 * rotation retires a key (`address_keys.retired_at`) without touching an id —
 * letter ids are stable against ANY party's rotation, not only the sender's.
 * For addresses without keys (legacy), the identity id IS the handle — the
 * identity IS the handle until a key exists; the key is what makes it durable.
 *
 * The wire format keeps the handle (people type ben@house); the store and the
 * id use the identity.
 *
 * The resolver is injected: the pipeline and the routes resolve handles
 * through `addresses.identity_id`. The pure function `canonicaliseWith`
 * takes the resolution map so it stays deterministic and testable.
 *
 * Rotation does not move a stored id. Two rules recover the id a sealed letter
 * was made over, because the archive spans them:
 *
 *   `resolvePinnedId` — the rule since 2026-11-08. The identity is durable, so
 *   the id does not vary at all; what varies is which generation's public half
 *   made the signature, so it is checked against each the sender has held.
 *
 *   `resolveSignedId` — the pre-pin rule, kept for verification. It re-derives
 *   the id from a resolution that still follows the live keys, walking the
 *   sender's history, which is what a client that predates the address book's
 *   `identityId` field computes. Accepting both is what keeps a deployed
 *   client working across the change.
 */
import { createHash } from "node:crypto";
import type { Letter } from "./types.js";

/** Resolve a set of handles to their identity ids. The map is
 *  handle → identity id; absent handles resolve to themselves (legacy —
 *  the identity IS the handle until a key exists). */
export type IdentityResolver = (handles: string[]) => Promise<Map<string, string>>;

/**
 * Canonical serialisation of a letter, with addresses resolved to their
 * identity ids. Field order is fixed so the hash is stable across
 * processes and platforms. Frames are sorted by (frame, value) so the
 * same set of frames hashes identically regardless of arrival order.
 */
export function canonicaliseWith(letter: Letter, identities: Map<string, string>): string {
  const frames = [...letter.time.frames]
    .sort((a, b) =>
      a.frame === b.frame ? a.value.localeCompare(b.value) : a.frame.localeCompare(b.frame),
    )
    .map((f) => `${f.frame}=${f.value}`)
    .join(",");

  const resolve = (handle: string) => identities.get(handle) ?? handle;

  return JSON.stringify({
    envelope: {
      from: resolve(letter.envelope.from),
      to: letter.envelope.to.map(resolve),
      cc: letter.envelope.cc.map(resolve),
      thread: letter.envelope.thread,
      kind: letter.envelope.kind,
      lang: letter.envelope.lang,
      subject: letter.envelope.subject,
    },
    time: {
      gregorian: letter.time.gregorian,
      frames,
    },
    body: canonicalBody(letter.body),
  });
}

/**
 * The body's canonical form. Frozen for the two original shapes — every stored
 * id was derived from them, so a new field appearing in their JSON would move
 * the whole archive's ids.
 *
 * The key frame is the one shape that has more to hash than text: its KEYS are
 * content (the signature is over the id, and the point of the signature is that
 * it covers the key material it publishes), and its own signature is excluded —
 * an id cannot hash the signature made over it. Fixed field order, so the
 * sender's client and this resolver agree byte for byte.
 */
function canonicalBody(
  body: Letter["body"],
): { format: string; content: string } | {
  format: "keyframe";
  content: string;
  keys: { ageRecipient: string; ed25519Public: string; recoveryAgeRecipient: string | null };
} {
  if (body.format !== "keyframe") return { format: body.format, content: body.content };
  return {
    format: "keyframe",
    content: body.content,
    keys: {
      ageRecipient: body.keys.ageRecipient,
      ed25519Public: body.keys.ed25519Public,
      recoveryAgeRecipient: body.keys.recoveryAgeRecipient,
    },
  };
}

/** Derive the letter id: sha256 hex of the canonical serialisation. */
export function letterIdFromCanonical(canonical: string): string {
  return createHash("sha256").update(canonical).digest("hex");
}

/** The legacy canonical form — handles as-is. Kept for the one-time
 *  re-index: old ids were derived from this form. */
export function canonicaliseLegacy(letter: Letter): string {
  return canonicaliseWith(letter, new Map());
}

/**
 * Resolve the id a sealed letter was SIGNED under, under the pin (SPEC §19,
 * amended 2026-11-08).
 *
 * The id no longer varies with the sender's key: the identity is durable, so a
 * sender who rotated hashes to the identity it registered first. What varies is
 * which KEY made the signature — rotation retires a key, it does not re-sign the
 * archive — so the signature is checked against every generation the sender has
 * held (newest first) and the id it covers is the one canonical form they all
 * share.
 *
 * Returns `null` when no key the sender has ever held verifies — the caller
 * falls through to the legacy rule, then rejects. An empty history (a keyless
 * legacy address) therefore cannot carry a sealed letter.
 *
 * `verify` is injected so this stays a pure function of the letter, the
 * resolution map and the key history (the pipeline passes the ed25519 check).
 */
export function resolvePinnedId(
  letter: Letter,
  identities: Map<string, string>,
  senderKeys: string[],
  signature: string,
  verify: (id: string, signature: string, publicKey: string) => boolean,
): string | null {
  const id = letterIdFromCanonical(canonicaliseWith(letter, identities));
  for (const key of senderKeys) {
    if (verify(id, signature, key)) return id;
  }
  return null;
}

/**
 * Resolve the id a sealed letter was SIGNED under, by the PRE-PIN rule — kept
 * for verification, not for writing (SPEC §15 key history; superseded by the
 * pin on 2026-11-08).
 *
 * Before the identity was pinned, the id resolved each handle to the key the
 * address held at that moment, so a rotation changed a fingerprint and the same
 * letter re-delivered after its sender had rotated hashed to a different id
 * while the signature still named the old one. The sender's key history names
 * every identity that address has held, so walk it (newest first) and keep the
 * id whose signature verifies under that key.
 *
 * Still load-bearing in two ways: the archive holds letters written under this
 * rule, and a deployed client that predates the address book's `identityId`
 * field still computes this way. `identities` for this rule must be the LIVE
 * key resolution, which is what such a client reads.
 *
 * Returns `null` when no key the sender has ever held verifies — the caller
 * rejects: the house does not store what it cannot verify. An empty history
 * (a keyless legacy address) therefore cannot carry a sealed letter.
 *
 * `identities` carries the resolution for every handle; only the sender's entry
 * is varied, so a self-addressed letter (from and to the same handle) resolves
 * consistently across both positions.
 *
 * Deliberately NOT done here: resolving the recipients' histories too. A
 * pre-pin letter re-delivered after a party other than the sender has rotated
 * cannot re-derive its signed id — a recorded limitation of the legacy rule,
 * not an oversight, and the very failure the pin removes for everything written
 * after it. Nothing in the archive depends on it: the archive stores the id it
 * verified, and stored ids never move.
 *
 * `verify` is injected so this stays a pure function of the letter, the
 * resolution map and the key history (the pipeline passes the ed25519 check).
 */
export function resolveSignedId(
  letter: Letter,
  identities: Map<string, string>,
  senderKeys: string[],
  signature: string,
  verify: (id: string, signature: string, publicKey: string) => boolean,
): string | null {
  for (const key of senderKeys) {
    const resolved = new Map(identities);
    resolved.set(letter.envelope.from, key);
    const id = letterIdFromCanonical(canonicaliseWith(letter, resolved));
    if (verify(id, signature, key)) return id;
  }
  return null;
}
