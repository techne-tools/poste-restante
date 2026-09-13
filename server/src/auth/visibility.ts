/**
 * Visibility — the house's authorization rule, derived from the schema.
 *
 * Private by default: a letter is visible to an address iff that address is
 * a participant (from/to/cc) OR the letter is public (pub@house is a
 * participant). The pub is the schema-level public exception — the house's
 * public face.
 *
 * Leaving as first-class (SPEC §5.8 related): participation is derived from
 * the leave/join letters (the `thread_participation` cache). A leaver's
 * edges dissolve — a letter in a thread the caller has left is NOT visible,
 * even though the historical participant edges stand. The default is 'in':
 * an address with no leave/join letter is a participant. Absence is
 * silence: callers return 404, never 403, for things the caller cannot
 * see. The house never confirms existence.
 */

export const PUB_ADDRESS = "pub@house";

export interface LetterParty {
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
}

export type ParticipationLike = "in" | "out" | "shelved";

/** A letter is public iff pub@house is a participant. */
export function isPublicLetter(l: LetterParty): boolean {
  return (
    l.from_addr === PUB_ADDRESS ||
    l.to_addrs.includes(PUB_ADDRESS) ||
    l.cc_addrs.includes(PUB_ADDRESS)
  );
}

/** An address is a participant iff it is from/to/cc on the letter. */
export function isParticipant(l: LetterParty, address: string): boolean {
  return (
    l.from_addr === address ||
    l.to_addrs.includes(address) ||
    l.cc_addrs.includes(address)
  );
}

/**
 * The door of an address's room. `is_public` is the schema's answer to
 * "may an unauthenticated reader look in?" Only pub@house carries the
 * flag in practice, but the rule is a property of the ROOM, not of the
 * name — no special case for 'pub@house' in the visibility path.
 */
export function isPublicAddress(addr: { is_public: boolean } | null): boolean {
  return addr !== null && addr.is_public;
}

/**
 * The visibility rule: participant AND currently-in-the-thread, OR public.
 * `participation` is the caller's derived state in the letter's thread —
 * 'in' by default (no leave/join letter means the historical edges stand).
 *
 * Leaving moves the correspondence from the mailbox to the archive: the
 * LEEVER still reads the history (the state surface promises "the archive
 * keeps the history"), but the mailbox, the whisper, and the gap engine
 * stop offering it. 'out' therefore keeps the participant edge visible
 * for reading — the thread is no longer live for the resident, but the
 * record of it stays in the archive, where the left state surface points.
 */
export function isVisibleTo(
  l: LetterParty & { thread_id: string },
  address: string,
  participation: ParticipationLike = "in",
): boolean {
  if (isPublicLetter(l)) return true;
  // 'shelved' and 'out' are read-as-history states: putting a thread away
  // is not leaving — the edges stand, the letters stay readable — and
  // leaving still keeps the archive's record readable (only the live
  // surfaces stop offering it: the mailbox and the whisper filter 'out'
  // and 'shelved' at their own SQL).
  return isParticipant(l, address);
}

/** Filter letters by visibility with the caller's participation states
 *  (thread_id → 'in' | 'out' | 'shelved'; absent means 'in' — the
 *  historical edges stand). Use after fetching the states for the
 *  letters' threads. */
export function filterVisible<T extends LetterParty & { thread_id: string }>(
  letters: T[],
  address: string,
  participation: Map<string, ParticipationLike>,
): T[] {
  return letters.filter(
    (l) => isVisibleTo(l, address, participation.get(l.thread_id) ?? "in"),
  );
}

/**
 * The SQL fragment for the visibility rule, bound to a parameter index.
 * Use as: `AND ${visibleToSql(i)}` with `params.push(address)`.
 *
 * The rule is participant OR public — leaving keeps the archive's record
 * readable (history), so there is no participation guard here. The live
 * surfaces that must NOT offer a left/shelved thread (the mailbox, the
 * IMAP sync) add their own explicit `NOT EXISTS ... state IN ('out',
 * 'shelved')` guard at their own query. This fragment is the archive's
 * rule: read-as-history, never a live offer.
 */
export function visibleToSql(paramIndex: number): string {
  return `(
    l.from_addr = '${PUB_ADDRESS}'
    OR '${PUB_ADDRESS}' = ANY(l.to_addrs)
    OR '${PUB_ADDRESS}' = ANY(l.cc_addrs)
    OR (
      l.from_addr = $${paramIndex}
      OR $${paramIndex} = ANY(l.to_addrs)
      OR $${paramIndex} = ANY(l.cc_addrs)
    )
  )`;
}
