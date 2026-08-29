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
  createdAt: r.created_at,
  openedAt: r.opened_at,
  dismissedAt: r.dismissed_at,
  repliedAt: r.replied_at,
});

export class WhisperService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly log: Logger,
  ) {}

  /** The whisper — the house's own letters, newest first. */
  async list(limit = 50): Promise<Whisper[]> {
    const { rows } = await this.pool.query<WhisperRow>(
      `SELECT * FROM whispers ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toWhisper);
  }

  /** The unread whisper — what the house is offering right now. */
  async listUnread(limit = 20): Promise<Whisper[]> {
    const { rows } = await this.pool.query<WhisperRow>(
      `SELECT * FROM whispers
       WHERE dismissed_at IS NULL
       ORDER BY created_at DESC LIMIT $1`,
      [limit],
    );
    return rows.map(toWhisper);
  }

  /** The user opened a whisper. A signal, not a notification. */
  async open(id: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE whispers SET opened_at = COALESCE(opened_at, now())
       WHERE id = $1 AND dismissed_at IS NULL`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Explicit dismissal — the strongest negative signal. */
  async dismiss(id: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE whispers SET dismissed_at = now() WHERE id = $1`,
      [id],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Undismiss — the user changed their mind. The house takes corrections at face value. */
  async undismiss(id: string): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE whispers SET dismissed_at = NULL WHERE id = $1`,
      [id],
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
   * `system` from the house's own address is ingested.
   */
  async surfaceHouseLetter(letterId: string, threadId: string, summary: string): Promise<void> {
    const id = `house:${letterId}`;
    await this.pool.query(
      `INSERT INTO whispers (id, letter_id, kind, target_thread, summary)
       VALUES ($1, $2, 'house-letter', $3, $4)
       ON CONFLICT (id) DO NOTHING`,
      [id, letterId, threadId, summary],
    );
    this.log.info("whisper:surfaced", { id, kind: "house-letter" });
  }

  /**
   * Cheap structural gap detection (SPEC §2.4): dormant threads and
   * unanswered questions. Postgres queries only — no expensive semantic
   * scans. Runs on demand; the house never pushes the results.
   */
  async detectGaps(now = new Date()): Promise<Whisper[]> {
    const created: Whisper[] = [];

    // Dormant thread: a correspondence with letters, none in the last 14
    // days, that the house hasn't whispered about recently (7 days — a
    // dismissal is respected; the house doesn't re-offer immediately).
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
         )`,
      [new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000), new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)],
    );
    for (const row of dormant.rows) {
      const id = `gap-dormant:${row.thread_id}`;
      await this.pool.query(
        `INSERT INTO whispers (id, kind, target_thread, summary)
         VALUES ($1, 'gap-dormant-thread', $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [id, row.thread_id, `A thread has gone quiet — ${row.thread_id} hasn't heard from you in a while.`],
      );
      created.push({
        id,
        letterId: null,
        kind: "gap-dormant-thread",
        targetThread: row.thread_id,
        summary: `A thread has gone quiet — ${row.thread_id} hasn't heard from you in a while.`,
        createdAt: now,
        openedAt: null,
        dismissedAt: null,
        repliedAt: null,
      });
    }

    // Unanswered question: a letter with a question mark, no reply in 7 days.
    const questions = await this.pool.query<{ thread_id: string }>(
      `SELECT DISTINCT l.thread_id
       FROM letters l
       WHERE l.body_text ~ '\\?'
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
         )`,
      [new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000)],
    );
    for (const row of questions.rows) {
      const id = `gap-question:${row.thread_id}`;
      await this.pool.query(
        `INSERT INTO whispers (id, kind, target_thread, summary)
         VALUES ($1, 'gap-unanswered-question', $2, $3)
         ON CONFLICT (id) DO NOTHING`,
        [id, row.thread_id, `A question is waiting in ${row.thread_id} — unanswered for a week.`],
      );
      created.push({
        id,
        letterId: null,
        kind: "gap-unanswered-question",
        targetThread: row.thread_id,
        summary: `A question is waiting in ${row.thread_id} — unanswered for a week.`,
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
