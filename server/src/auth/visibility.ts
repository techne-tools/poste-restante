/**
 * Visibility — the house's authorization rule, derived from the schema.
 *
 * Private by default: a letter is visible to an address iff that address is
 * a participant (from/to/cc) OR the letter is public (pub@house is a
 * participant). The pub is the schema-level public exception — the house's
 * public face.
 *
 * Absence is silence: callers return 404, never 403, for things the caller
 * cannot see. The house never confirms existence.
 */

export const PUB_ADDRESS = "pub@house";

export interface LetterParty {
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
}

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

/** The visibility rule: participant OR public. */
export function isVisibleTo(l: LetterParty, address: string): boolean {
  return isPublicLetter(l) || isParticipant(l, address);
}

/**
 * The SQL fragment for the visibility rule, bound to a parameter index.
 * Use as: `AND ${visibleToSql(i)}` with `params.push(address)`.
 */
export function visibleToSql(paramIndex: number): string {
  return `(
    l.from_addr = '${PUB_ADDRESS}'
    OR '${PUB_ADDRESS}' = ANY(l.to_addrs)
    OR '${PUB_ADDRESS}' = ANY(l.cc_addrs)
    OR l.from_addr = $${paramIndex}
    OR $${paramIndex} = ANY(l.to_addrs)
    OR $${paramIndex} = ANY(l.cc_addrs)
  )`;
}
