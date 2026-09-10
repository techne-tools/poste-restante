/**
 * LetterReadsService — the living pass read-back (SPEC §5 #12).
 *
 * The house records opened/replied on whispers, not letters. This is the
 * per-resident letter_reads table: the learning loop's signals, recorded
 * per (letter, resident), so the house can read what the resident
 * actually engaged with — through the reference client or through IMAP
 * flags (\\Seen ⇄ opened, \\Answered ⇄ replied, \\Flagged ⇄ pinned).
 *
 * Privacy as schema: a row is per (letter, resident) — the house records
 * only what the resident themselves did. No global read state.
 *
 * The archive is the truth; this is the rememberer's cache. Wiping and
 * re-deriving from the letters + the client's signals yields the same
 * rows.
 */
import type pg from "pg";

export class LetterReadsService {
  constructor(private readonly pool: pg.Pool) {}

  /** Record that a resident opened a letter — a signal, not a
   *  notification. Idempotent: the first open wins. */
  async open(letterId: string, address: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO letter_reads (letter_id, address_id, opened_at)
       VALUES ($1, $2, now())
       ON CONFLICT (letter_id, address_id) DO UPDATE
         SET opened_at = COALESCE(letter_reads.opened_at, now())`,
      [letterId, address],
    );
  }

  /** Record that a resident replied to a letter's thread — the strongest
   *  signal. Idempotent. */
  async replied(letterId: string, address: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO letter_reads (letter_id, address_id, replied_at)
       VALUES ($1, $2, now())
       ON CONFLICT (letter_id, address_id) DO UPDATE
         SET replied_at = COALESCE(letter_reads.replied_at, now())`,
      [letterId, address],
    );
  }

  /** The resident's read state for a set of letters — what the house
   *  knows they engaged with. Returns a map letter_id → { opened, replied }. */
  async stateFor(
    address: string,
    letterIds: string[],
  ): Promise<Map<string, { opened: boolean; replied: boolean }>> {
    if (letterIds.length === 0) return new Map();
    const { rows } = await this.pool.query<{
      letter_id: string;
      opened_at: Date | null;
      replied_at: Date | null;
    }>(
      `SELECT letter_id, opened_at, replied_at
       FROM letter_reads
       WHERE address_id = $1 AND letter_id = ANY($2)`,
      [address, letterIds],
    );
    return new Map(
      rows.map((r) => [
        r.letter_id,
        { opened: r.opened_at !== null, replied: r.replied_at !== null },
      ]),
    );
  }
}
