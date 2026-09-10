/**
 * Letter identity — the identity-key protocol (SPEC §19).
 *
 * The id is `sha256` of the canonical serialisation of the envelope +
 * body, where the envelope's addresses are resolved to their IDENTITY
 * ids (the ed25519 public key fingerprint, §15) before hashing. A rename
 * never changes a letter's id — the integrity spine (dedup, references,
 * payloads, qdrant points) holds through the change.
 *
 * The wire format keeps the handle (people type ben@house); the store
 * and the id use the identity. For addresses without keys (legacy), the
 * identity id IS the handle — the identity IS the handle until a key
 * exists; the key is what makes it durable.
 *
 * The resolver is injected: the pipeline and the routes resolve handles
 * through the address_keys table. The pure function `canonicaliseWith`
 * takes the resolution map so it stays deterministic and testable.
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
    body: {
      format: letter.body.format,
      content: letter.body.content,
    },
  });
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
