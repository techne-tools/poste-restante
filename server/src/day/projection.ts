/**
 * The day projection — the callsheet whiteboard (SPEC §18).
 *
 * A callsheet is the theatre day's working document: who's on, when,
 * where, for what. The house has been holding everything a callsheet
 * needs — letters with frames, agents with tasks and frames, the
 * whisper's current offering, the book's standing clauses — so the board
 * is not a new data model; it is a *projection of what the house already
 * knows*, arranged by time.
 *
 * Derived, never stored: the board is a view, not a table. Wipe it and
 * re-derive, and the same board returns. There is no "board state"
 * column, no board schema; the board is a query over letters, frames,
 * agents, whisper, and book.
 *
 * Privacy is the same line as everywhere: the board shows only what the
 * resident is party to — derived visibility, never a new limb. The book
 * appears because it is commons by right. A board row that would name a
 * thread the resident cannot see does not exist.
 *
 * Presence not pressure: the board holds; it never pings. It is a place
 * to look, not a notification channel — no badges, no red, no "N unseen"
 * anywhere.
 */
import type pg from "pg";
import type { WhisperService } from "../whisper/service.js";
import type { BookService } from "../book/service.js";

/** One row of the board — a letter in its frame's column. */
export interface DayLetter {
  letterId: string;
  thread: string;
  subject: string;
  kind: string;
  from: string;
  receivedAt: string;
  frames: { frame: string; value: string }[];
}

/** An instrument alive in a frame — the agent's task line. */
export interface DayAgent {
  address: string;
  task: string;
  creator: string;
  lifespanFrame: string | null;
}

/** The day's projection — what the resident can see, arranged by time. */
export interface DayProjection {
  /** The resident's active frames, with their letters in order. */
  frames: {
    frame: string;
    letters: DayLetter[];
  }[];
  /** The resident's instruments alive in those frames. */
  agents: DayAgent[];
  /** The whisper's current offers — what the house is offering right now. */
  whispers: {
    id: string;
    kind: string;
    summary: string;
    targetThread: string | null;
    targetFrame: string | null;
  }[];
  /** The book's standing clauses that bear on the day. */
  clauses: { thread: string; text: string; state: string }[];
}

export class DayProjectionService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly whisper: WhisperService,
    private readonly book: BookService,
  ) {}

  /**
   * The resident's day. Letters in their visible frames (the same
   * derived-participation query every face uses), agents they created
   * alive in those frames, the whisper's current offers, the book's
   * standing clauses. Derived, never stored.
   */
  async project(address: string): Promise<DayProjection> {
    // The resident's active frames — the same 30-day derivation as the
    // whisper's corner gap: frames the resident has letters in, recent.
    const frames = await this.pool.query<{ frame_id: string }>(
      `SELECT DISTINCT lf.frame_id
       FROM letter_frames lf
       JOIN letter_addresses la ON la.letter_id = lf.letter_id
       WHERE la.address_id = $1
         AND EXISTS (
           SELECT 1 FROM letters l2
           JOIN letter_frames lf2 ON lf2.letter_id = l2.id
           WHERE lf2.frame_id = lf.frame_id AND l2.received_at > $2
         )
       ORDER BY lf.frame_id`,
      [address, new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)],
    );

    const frameIds = frames.rows.map((r) => r.frame_id);
    const frameLetters: DayProjection["frames"] = [];

    for (const { frame_id } of frames.rows) {
      // Letters in this frame the resident is party to — the same
      // derived-participation limb as every other face.
      const letters = await this.pool.query<{
        id: string;
        thread_id: string;
        subject: string;
        kind: string;
        from_addr: string;
        received_at: Date;
        frames: { frame: string; value: string }[];
      }>(
        `SELECT l.id, l.thread_id, l.subject, l.kind, l.from_addr, l.received_at,
                COALESCE(
                  (SELECT json_agg(json_build_object('frame', f.name, 'value', f.value))
                   FROM letter_frames lf JOIN frames f ON f.id = lf.frame_id
                   WHERE lf.letter_id = l.id), '[]'::json) AS frames
         FROM letters l
         JOIN letter_frames lf ON lf.letter_id = l.id
         JOIN letter_addresses la ON la.letter_id = l.id
         WHERE lf.frame_id = $1 AND la.address_id = $2
         ORDER BY l.received_at DESC
         LIMIT 20`,
        [frame_id, address],
      );
      frameLetters.push({
        frame: frame_id,
        letters: letters.rows.map((l) => ({
          letterId: l.id,
          thread: l.thread_id,
          subject: l.subject,
          kind: l.kind,
          from: l.from_addr,
          receivedAt: l.received_at.toISOString(),
          frames: l.frames,
        })),
      });
    }

    // The resident's instruments alive in those frames.
    const agents = await this.pool.query<{
      address: string;
      task: string;
      creator: string;
      lifespan_frame: string | null;
    }>(
      `SELECT address, task, creator, lifespan_frame
       FROM agents
       WHERE creator = $1 AND died_at IS NULL
       ORDER BY created_at DESC`,
      [address],
    );

    // The whisper's current offers — what the house is offering right now.
    const whispers = await this.whisper.listUnread(address, 10);

    // The book's standing clauses — commons by right.
    const head = await this.book.head();

    return {
      frames: frameLetters,
      agents: agents.rows.map((a) => ({
        address: a.address,
        task: a.task,
        creator: a.creator,
        lifespanFrame: a.lifespan_frame,
      })),
      whispers: whispers.map((w) => ({
        id: w.id,
        kind: w.kind,
        summary: w.summary,
        targetThread: w.targetThread,
        targetFrame: w.targetFrame,
      })),
      clauses: head.clauses
        .filter((c) => c.state === "standing")
        .map((c) => ({ thread: c.thread, text: c.text, state: c.state })),
    };
  }
}
