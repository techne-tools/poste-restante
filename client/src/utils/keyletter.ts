/**
 * The keyletter, client side — SPEC §15.
 *
 * A correspondent with an address and no keys cannot be sealed to: the composer
 * says so, and `sealDraft` refuses. The remedy used to be out of band — they
 * make a keystore in their own record and register the public halves. This is
 * the in-band one: a letter whose body is a key frame, signed with the key it
 * publishes, so the first keyletter from an address binds that address's keys
 * (TOFU on first sight) and everything after it can be sealed.
 *
 * The id is derived EXACTLY as the house derives it — the same canonical form,
 * the same identity resolution (a handle to its durable identity), the same
 * sha256. The signature is over that id, made with the private half of the key
 * inside the frame. If this module and `server/src/id.ts` ever disagree by a
 * byte, the house refuses the letter: that is the test, not a comment.
 *
 * Nothing here mints a key. The keyletter publishes the keys the resident
 * already holds, and it needs the keystore open to reach the signing key — a
 * frame signed without a passphrase would be a signing key anyone can use.
 */
import type { Address } from "../api";
import type { LetterBody } from "../api/types";
import {
  canonicalise,
  ensureKeys,
  identityOf,
  letterIdFromCanonical,
  type LetterForCanonical,
  type ParticipantKeys,
} from "./crypto";
import { importSigningKey, signLetterIdWithKey } from "./keys";
import { signingKeyOf } from "./keystore";

/** The house's default note. Quiet, factual, and replaceable — the resident's
 *  own sentence travels in `note` when they write one. */
export const KEY_LETTER_NOTE = "These are my keys — seal to me.";

export interface KeyLetterResult {
  letter: KeyLetter;
  /** The id the frame's signature names — the same hash the house derives. */
  id: string;
}

export interface KeyLetter {
  envelope: LetterForCanonical["envelope"];
  time: LetterForCanonical["time"];
  body: Extract<LetterBody, { format: "keyframe" }>;
}

/**
 * Compose a keyletter from `from` to `to`.
 *
 * `addressBook` is the same list the composer seals from: it is how each
 * handle resolves to its identity (the value the id hashes). The sender's own
 * entry may be absent — a resident sending keys for the first time has none
 * registered yet, and then their identity is their handle.
 */
export async function composeKeyLetter(input: {
  from: string;
  to: string;
  /** The sentence that travels with the keys. */
  note?: string;
  /** A thread to continue; a fresh one by default. Keys belong in their own
   *  correspondence — a keyletter is an announcement, not a reply. */
  thread?: string;
  addressBook: ParticipantKeys[];
  frames?: { frame: string; value: string }[];
  /** The time the letter is written; injected so a test can pin it. */
  gregorian?: string;
}): Promise<KeyLetterResult> {
  const keys = ensureKeys(input.from);
  const identityMap = new Map<string, string>();

  const own = input.addressBook.find((a) => a.id === input.from);
  // The sender resolves to what the house's record says NOW — `identityId`,
  // which is the handle for an address that has never registered.
  //
  // Deliberately NOT `keys.ed25519Public` the way `sealDraft` falls back: that
  // fallback exists because a seal REGISTERS the halves first (minting, when
  // needed), so the pin is already in place by the time the house re-derives
  // the id. A keyletter registers nothing — installing keys is its whole
  // point, and it never pins — so hashing the new key here would name an id
  // the house cannot derive, and the letter would be refused at the gate.
  identityMap.set(input.from, identityOf(own ?? { id: input.from }));

  const recipient = input.addressBook.find((a) => a.id === input.to);
  identityMap.set(input.to, identityOf(recipient ?? { id: input.to }));

  const draft: LetterForCanonical = {
    envelope: {
      from: input.from,
      to: [input.to],
      cc: [],
      thread: input.thread?.trim() || `th_key_${Date.now().toString(36)}`,
      kind: "keyletter",
      lang: "en-AU",
      subject: "my keys",
    },
    time: {
      gregorian: input.gregorian ?? new Date().toISOString(),
      frames: input.frames ?? [],
    },
    body: {
      format: "keyframe",
      content: (input.note ?? KEY_LETTER_NOTE).trim(),
      keys: {
        ageRecipient: keys.ageRecipient,
        ed25519Public: keys.ed25519Public,
        recoveryAgeRecipient: keys.recoveryAgeRecipient,
      },
    },
  };

  const id = await letterIdFromCanonical(canonicalise(draft, identityMap));
  const signing = signingKeyOf(input.from) ?? (await importSigningKey(keys.ed25519Private));
  const signature = await signLetterIdWithKey(id, signing);

  return {
    id,
    letter: {
      envelope: draft.envelope,
      time: draft.time,
      body: {
        format: "keyframe",
        keys: draft.body.keys!,
        content: draft.body.content,
        signature,
      },
    },
  };
}

/** Whether this address can be sent a keyletter at all — it has an address,
 *  and it is not the sender. The point of the letter is a KEYLESS
 *  correspondent, but nothing breaks if one is sent to somebody who already
 *  has keys: the house treats a matching frame as a no-op and a differing one
 *  as an offer. */
export function canReceiveKeys(address: Address | undefined, self: string): boolean {
  return Boolean(address) && address!.id !== self && !address!.isAgent;
}
