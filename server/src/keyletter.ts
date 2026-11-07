/**
 * The keyletter — a letter that carries a public key (SPEC §15).
 *
 * A new correspondent has an address and no keys, and there is no way to tell
 * them out of band in the house's own idiom. A keyletter is that: a letter
 * whose body is a key frame (`kind: "keyletter"`, `format: "keyframe"`),
 * signed with the ed25519 key it publishes, over its own letter id.
 *
 * ── What a keyletter proves, and what it does not ────────────────────────
 *
 * It proves POSSESSION OF THE KEY: the signature over the id was made with the
 * private half of the ed25519 public key the frame carries. That is checkable
 * here, with one public key and no other state.
 *
 * It does not prove the ADDRESS. The letter faces bind `from` to the
 * authenticated caller (HTTP, MCP and SMTP all do — see routes/letters.ts,
 * mcp/server.ts, bridge/smtp.ts), and that binding is what makes the claim
 * meaningful; the pipeline cannot re-check it and does not pretend to. Where a
 * registration answers a house-issued challenge with the key it is installing
 * (auth/key-proof.ts), a keyletter answers nothing — it simply arrives.
 *
 * That difference is the whole design, and it is why:
 *
 *   * the write records `origin = 'keyletter'` (migration 034), so the history
 *     says how the key arrived rather than implying every key was proven;
 *   * a keyletter NEVER pins `addresses.identity_id`. A key that arrived by
 *     TOFU has proven the key, not the address. The address keeps resolving to
 *     its handle until its owner registers with proof — and its letters still
 *     verify either way, because verification walks the sender's key history.
 *   * FIRST SIGHT installs (there is nothing to contradict — this is the TOFU
 *     bind that makes a keyless correspondent reachable);
 *   * a DIFFERENT key against an existing live record does not install. It
 *     becomes an offer a human answers, because everyone who already sealed to
 *     the old key needs to know the key moved.
 */
import type { KeyFrameBody, Letter } from "./types.js";
import { keyFingerprint, verifyLetterId } from "./crypto/keys.js";
import type { PostgresRepository } from "./db/repository.js";
import type { Logger } from "./pipeline/logger.js";
import { addressTag } from "./pipeline/logger.js";
import { isVisibleTo } from "./auth/visibility.js";

/** A keyletter whose body is a key frame — the only shape this module takes. */
export type KeyLetter = Letter & { body: KeyFrameBody };

/** What verification can say. Two silences, told apart: a frame that carries
 *  no signature at all is not the same fact as one whose signature does not
 *  verify, and the route answers them with different words. */
export type KeyFrameVerdict = { ok: true } | { ok: false; reason: "unsigned" | "bad_signature" };

/**
 * Verify a key frame's signature over the letter id it was derived under.
 *
 * The identity used is the one `resolveId` already resolved (the durable
 * identity, or the handle for an address with no key) — the same form the
 * sender's client hashed, which is what makes the check meaningful rather than
 * decorative.
 */
export function verifyKeyFrame(id: string, body: KeyFrameBody): KeyFrameVerdict {
  if (!body.signature.trim()) return { ok: false, reason: "unsigned" };
  return verifyLetterId(id, body.signature, body.keys.ed25519Public)
    ? { ok: true }
    : { ok: false, reason: "bad_signature" };
}

/** What the house did with a verified keyletter. */
export type KeyFrameEffect = "installed" | "unchanged" | "offered";

/**
 * Who may answer an offer: the address itself, or anyone who can SEE the
 * keyletter that carried the change.
 *
 * Visibility is derived from the letter's participant edges — the same rule
 * every letter read uses — never granted by the route (AGENTS.md privacy
 * checklist #2). A resident who is not party to the letter is answered exactly
 * as if no offer existed: the caller cannot tell the difference between "no
 * such change" and "not yours", which is the house's absence-is-silence rule.
 *
 * Named and exported rather than inlined in the route because it is the
 * privacy decision, and a decision deserves a test that proves the negative.
 */
export async function mayAnswerKeyOffer(
  repo: PostgresRepository,
  who: string,
  address: string,
  letterId: string,
): Promise<boolean> {
  if (who === address) return true;
  const row = await repo.getLetter(letterId);
  if (!row) return false;
  const states = await repo.participationStates([row.thread_id], who);
  return isVisibleTo(row, who, states.get(row.thread_id) ?? "in");
}

/**
 * Apply a VERIFIED keyletter's keys. Idempotent by construction — the decision
 * is a function of the live key record, so a re-delivery re-asserts the same
 * outcome and never stacks history.
 *
 *   no live key          → install (origin 'keyletter', source letter id).
 *                          First sight binds; this is the TOFU the card asks
 *                          for, and the only case where a keyletter writes a
 *                          key record.
 *   same keys            → nothing to do; any pending offer is satisfied by
 *                          the live record and is settled as accepted.
 *   different keys       → an offer. Never a silent overwrite: the old key is
 *                          still what letters were sealed to, and the change
 *                          waits for a human.
 *
 * Logs carry the letter id (a content hash), a hashed address tag and
 * fingerprint tails — never an address, never a key (AGENTS.md privacy
 * checklist #6).
 */
export async function applyKeyFrame(
  repo: PostgresRepository,
  log: Logger,
  letter: KeyLetter,
  letterId: string,
): Promise<KeyFrameEffect> {
  const address = letter.envelope.from;
  const keys = letter.body.keys;
  const live = await repo.getAddressKey(address);
  const tails = {
    addressTag: addressTag(address),
    key: keyFingerprint(keys.ed25519Public).slice(0, 8),
    letterId,
  };

  if (live === null) {
    await repo.setAddressKey(address, keys, "keyletter", letterId);
    log.info("keys:keyletter-installed", tails);
    return "installed";
  }

  const same =
    live.age_recipient === keys.ageRecipient &&
    live.ed25519_public === keys.ed25519Public &&
    live.recovery_age_recipient === keys.recoveryAgeRecipient;

  if (same) {
    // The live record already says this. A pending offer for these keys has
    // been answered by the record itself, so it is settled rather than left
    // standing as a question with no difference in it.
    await repo.resolveKeyOffer(address, "accepted");
    return "unchanged";
  }

  await repo.saveKeyOffer(address, letterId, keys);
  log.info("keys:keyletter-offer", {
    ...tails,
    live: live.ed25519_public ? keyFingerprint(live.ed25519_public).slice(0, 8) : null,
  });
  return "offered";
}
