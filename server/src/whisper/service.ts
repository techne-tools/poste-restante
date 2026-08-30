/**
 * The whisper — the mailbox for the house's own letters.
 *
 * The house writes letters too: summaries, questions, observations, gap
 * offers. They are correspondence, not metadata. The whisper surfaces them
 * when relevant and stays quiet when not. The strongest signal is writing
 * back.
 *
 * The learning loop (SPEC §2.4):
 *   opening a whisper        → signal (opened)
 *   explicit dismissal       → strongest negative (dismissed)
 *   writing back             → strongest positive (replied)
 *
 * Presence not pressure: the whisper is a GET resource. Nothing pushes.
 *
 * Multi-user privacy: the whisper is scoped to an address. A whisper is
 * visible to an address iff that address is a participant in the whisper's
 * target thread (derived from letter_addresses — the social graph). The
 * house never gossips about correspondence you are not party to, and you
 * cannot open, dismiss, or undismiss a whisper about someone else's thread.
 * This is privacy as schema: the visibility rule is derived, not a policy.
 */
import type pg from "pg";
import type { Logger } from "../pipeline/logger.js";

export type WhisperKind =
  | "house-letter"
  | "gap-dormant-thread"
  | "gap-unanswered-question";

export interface Whisper {
  id: string;
  letterId: string | null;
  kind: WhisperKind;
  targetThread: string | null;
  summary: string;
  reasoning: string | null;
  createdAt: Date;
  openedAt: Date | null;
  dismissedAt: Date | null;
  repliedAt: Date | null;
}

export interface WhisperRow {
  id: string;
  letter_id: string | null;
  kind: WhisperKind;
  target_thread: string | null;
  summary: string;
  reasoning: string | null;
  created_at: Date;
  opened_at: Date | null;
  dismissed_at: Date | null;
  replied_at: Date | null;
}

const toWhisper = (r: WhisperRow): Whisper => ({
  id: r.id,
  letterId: r.letter_id,
  kind: r.kind,
  targetThread: r.target_thread,
  summary: r.summary,
  reasoning: r.reasoning,
  createdAt: r.created_at,
  openedAt: r.opened_at,
  dismissedAt: r.dismissed_at,
  repliedAt: r.replied_at,
});

/**
 * The visibility predicate. A whisper is visible to an address iff the
 * address is a participant in the whisper's thread. `w` is the whispers
 * alias; `$1` is the address. Every whisper kind sets target_thread, so a
 * whisper with a NULL thread is visible to no one (it cannot exist in
 * practice — the invariant is enforced by the writers).
 */
const VISIBLE_TO = `
  w.target_thread IS NOT NULL
  AND EXISTS (
    SELECT 1 FROM letters l
    JOIN letter_addresses la ON la.letter_id = l.id
    WHERE l.thread_id = w.target_thread
      AND la.address_id = $1
  )`;

export class WhisperService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly log: Logger,
  ) {}

  /** The whisper — the house's own letters, newest first, scoped to an address. */
  async list(address: string, limit = 50): Promise<Whisper[]> {
    const { rows } = await this.pool.query<WhisperRow>(
      `SELECT w.* FROM whispers w
       WHERE ${VISIBLE_TO}
       ORDER BY w.created_at DESC LIMIT $2`,
      [address, limit],
    );
    return rows.map(toWhisper);
  }

  /** The unread whisper — what the house is offering this address right now. */
  async listUnread(address: string, limit = 20): Promise<Whisper[]> {
    const { rows } = await this.pool.query<WhisperRow>(
      `SELECT w.* FROM whispers w
       WHERE ${VISIBLE_TO} AND w.dismissed_at IS NULL
       ORDER BY w.created_at DESC LIMIT $2`,
      [address, limit],
    );
    return rows.map(toWhisper);
  }

  /** The user opened a whisper. A signal, not a notification. Scoped: you can only open what you can see. */
  async open(id: string, address: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE whispers w SET opened_at = COALESCE(opened_at, now())
       WHERE w.id = $2 AND w.dismissed_at IS NULL AND ${VISIBLE_TO}`,
      [address, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Explicit dismissal — the strongest negative signal. Scoped: you can only dismiss what you can see. */
  async dismiss(id: string, address: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE whispers w SET dismissed_at = now()
       WHERE w.id = $2 AND ${VISIBLE_TO}`,
      [address, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Undismiss — the user changed their mind. The house takes corrections at face value. Scoped. */
  async undismiss(id: string, address: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE whispers w SET dismissed_at = NULL
       WHERE w.id = $2 AND ${VISIBLE_TO}`,
      [address, id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Writing back — the strongest signal. Called when a letter lands in a whispered thread. */
  async recordReply(threadId: string): Promise<void> {
    await this.pool.query(
      `UPDATE whispers SET replied_at = now()
       WHERE target_thread = $1 AND replied_at IS NULL`,
      [threadId],
    );
  }

  /**
   * Surface a house letter in the whisper. Called when a letter of kind
   * `system` from the house's own address is ingested. The summary is the
   * lede; the reasoning is the letter itself — the offer shows its work.
   */
  async surfaceHouseLetter(
    letterId: string,
    threadId: string,
    summary: string,
    reasoning: string | null = null,
  ): Promise<void> {
    const id = `house:${letterId}`;
    await this.pool.query(
      `INSERT INTO whispers (id, letter_id, kind, target_thread, summary, reasoning)
       VALUES ($1, $2, 'house-letter', $3, $4, $5)
       ON CONFLICT (id) DO NOTHING`,
      [id, letterId, threadId, summary, reasoning],
    );
    this.log.info("whisper:surfaced", { id, kind: "house-letter" });
  }

  /**
   * Cheap structural gap detection (SPEC §2.4): dormant threads and
   * unanswered questions. Postgres queries only — no expensive semantic
   * scans. Runs on demand; the house never pushes the results.
   *
   * Scoped to an address: gaps are only offered for threads the address
   * participates in. The house does not whisper about other people's mail.
   */
  async detectGaps(address: string, now = new Date()): Promise<Whisper[]> {
    const created: Whisper[] = [];

    // Dormant thread: a correspondence with letters, none in the last 14
    // days, that the house hasn't whispered about recently (7 days — a
    // dismissal is respected; the house doesn't re-offer immediately).
    // Only threads the address participates in.
    const dormant = await this.pool.query<{ thread_id: string }>(
      `SELECT t.id AS thread_id
       FROM threads t
       JOIN letters l ON l.thread_id = t.id
       GROUP BY t.id
       HAVING max(l.received_at) < $1 AND count(*) >= 2
         AND NOT EXISTS (
           SELECT 1 FROM whispers w
           WHERE w.target_thread = t.id
             AND w.kind = 'gap-dormant-thread'
             AND w.created_at > $2
         )
         AND EXISTS (
           SELECT 1 FROM letters l2
           JOIN letter_addresses la ON la.letter_id = l2.id
           WHERE l2.thread_id = t.id AND la.address_id = $3
         )`,
      [
        new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
        new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        address,
      ],
    );
    for (const row of dormant.rows) {
      const id = `gap-dormant:${row.thread_id}`;
      const reasoning = `The last letter in ${row.thread_id} arrived more than 14 days ago, and the thread has at least two letters — a correspondence, not a one-off. The house holds it, quietly.`;
      await this.pool.query(
        `INSERT INTO whispers (id, kind, target_thread, summary, reasoning)
         VALUES ($1, 'gap-dormant-thread', $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, row.thread_id, `A thread has gone quiet — ${row.thread_id} hasn't heard from you in a while.`, reasoning],
      );
      created.push({
        id,
        letterId: null,
        kind: "gap-dormant-thread",
        targetThread: row.thread_id,
        summary: `A thread has gone quiet — ${row.thread_id} hasn't heard from you in a while.`,
        reasoning,
        createdAt: now,
        openedAt: null,
        dismissedAt: null,
        repliedAt: null,
      });
    }

    // Unanswered question: a letter with a question mark, no reply in 7 days.
    // Only threads the address participates in.
    const questions = await this.pool.query<{ thread_id: string }>(
      `SELECT DISTINCT l.thread_id
       FROM letters l
       WHERE l.body_text ~ '\\\\?'
         AND l.received_at < $1
         AND NOT EXISTS (
           SELECT 1 FROM letters l2
           WHERE l2.thread_id = l.thread_id
             AND l2.received_at > l.received_at
         )
         AND NOT EXISTS (
           SELECT 1 FROM whispers w
           WHERE w.target_thread = l.thread_id
             AND w.kind = 'gap-unanswered-question'
             AND w.dismissed_at IS NULL
         )
         AND EXISTS (
           SELECT 1 FROM letters l3
           JOIN letter_addresses la ON la.letter_id = l3.id
           WHERE l3.thread_id = l.thread_id AND la.address_id = $2
         )`,
      [new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), address],
    );
    for (const row of questions.rows) {
      const id = `gap-question:${row.thread_id}`;
      const reasoning = `The most recent letter in ${row.thread_id} ends with a question, and nothing has been written back in 7 days. The house is not answering for you — it is holding the question open.`;
      await this.pool.query(
        `INSERT INTO whispers (id, kind, target_thread, summary, reasoning)
         VALUES ($1, 'gap-unanswered-question', $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, row.thread_id, `A question is waiting in ${row.thread_id} — unanswered for a week.`, reasoning],
      );
      created.push({
        id,
        letterId: null,
        kind: "gap-unanswered-question",
        targetThread: row.thread_id,
        summary: `A question is waiting in ${row.thread_id} — unanswered for a week.`,
        reasoning,
        createdAt: now,
        openedAt: null,
        dismissedAt: null,
        repliedAt: null,
      });
    }

    if (created.length > 0) {
      this.log.info("whisper:gaps", { count: created.length });
    }
    return created;
  }
}
