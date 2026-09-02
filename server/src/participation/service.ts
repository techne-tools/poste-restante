/**
 * Leaving as first-class — the structural stop (SPEC §5.8 related).
 *
 * Consent-forward: no and yes are equally significant. Leaving is the
 * structural stop on a thread — the move that protects you from someone
 * protects them from you, symmetric by construction.
 *
 * Leave/join are letters. A resident writes a `kind: "leave"` letter to
 * the thread (addressed to the thread's current participants — the act is
 * the correspondence); a `kind: "join"` letter reverses it. The archive
 * keeps the history; "current" is derived.
 *
 * This service is the rememberer: it reads the leave/join letters and
 * derives the participation state. It is never the author — every act is
 * a letter, and the archive keeps the history. The `thread_participation`
 * table is the rememberer's cache — wiping it and re-deriving from the
 * letters yields the same rows.
 *
 * The state machine (mechanical, stated will only):
 *
 *   leave → state=out. The leaver's edges dissolve — visibility prunes
 *           itself. The archive keeps the history; the leaver can rejoin.
 *   join  → state=in. The historical edges stand again.
 *
 * Out-of-order arrival: the cache upsert is guarded by received_at — a
 * stale leave cannot overwrite a newer join (and vice versa). The letters
 * are the source of truth; the cache is derived.
 *
 * The book is exempt: clause threads are commons by right — you cannot
 * leave the household's knowing of itself. Leave/join on clause threads
 * is refused at the route.
 */
import type pg from "pg";
import type { Logger } from "../pipeline/logger.js";
import type { IngestionPipeline } from "../pipeline/pipeline.js";
import type { Letter } from "../types.js";

export type ParticipationState = "in" | "out";

export interface ParticipationRow {
  thread_id: string;
  address_id: string;
  state: ParticipationState;
  since_letter_id: string;
  since_received_at: Date;
}

export class ParticipationService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly pipeline: IngestionPipeline,
    private readonly log: Logger,
  ) {}

  /**
   * Perform a leave or join — write the letter (the act IS the letter;
   * the archive keeps the history), then record the derived state.
   * Returns the letter id and the new participation state.
   */
  async act(
    who: string,
    threadId: string,
    kind: "leave" | "join",
  ): Promise<{ letterId: string; state: ParticipationState }> {
    // The letter is addressed to the thread's current participants — the
    // act is the correspondence. The leaver is `from`; the others receive.
    const { rows } = await this.pool.query<{ address_id: string }>(
      `SELECT DISTINCT la.address_id
       FROM letter_addresses la
       JOIN letters l ON l.id = la.letter_id
       WHERE l.thread_id = $1 AND la.address_id <> $2`,
      [threadId, who],
    );
    const to = rows.map((r) => r.address_id);
    if (to.length === 0) to.push(who); // a thread with no other participants — the letter is to oneself

    const letter: Letter = {
      envelope: {
        from: who,
        to,
        cc: [],
        thread: threadId,
        kind,
        lang: "en-AU",
        subject: kind === "leave" ? "i am leaving this correspondence" : "i am rejoining this correspondence",
      },
      time: { gregorian: new Date().toISOString(), frames: [] },
      body: {
        format: "markdown",
        content:
          kind === "leave"
            ? "i am leaving this correspondence. the archive keeps the history; i am no longer party to it."
            : "i am rejoining this correspondence. the historical edges stand again.",
      },
    };

    const { letterId } = await this.pipeline.ingest(letter);
    // Record with the derived id — the cache's `since_letter_id` must
    // reference the stored letter.
    const state = await this.record({ ...letter, id: letterId });
    return { letterId, state };
  }

  /**
   * Record a leave/join letter's effect on the participation cache. Called
   * from the pipeline after a leave/join letter is stored (the single write
   * path — every protocol face goes through ingest). Idempotent: the same
   * letter records the same state.
   */
  async record(letter: Letter): Promise<ParticipationState> {
    const kind = letter.envelope.kind;
    if (kind !== "leave" && kind !== "join") {
      throw new Error("participation:record expects a leave or join letter");
    }
    const state: ParticipationState = kind === "leave" ? "out" : "in";
    const receivedAt = new Date(letter.time.gregorian);
    const letterId = letter.id ?? "";

    // The upsert guard: only a newer letter may overwrite the state. A
    // stale leave cannot overwrite a newer join (and vice versa).
    await this.pool.query(
      `INSERT INTO thread_participation (thread_id, address_id, state, since_letter_id, since_received_at)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (thread_id, address_id) DO UPDATE SET
         state = EXCLUDED.state,
         since_letter_id = EXCLUDED.since_letter_id,
         since_received_at = EXCLUDED.since_received_at
       WHERE thread_participation.since_received_at <= EXCLUDED.since_received_at`,
      [letter.envelope.thread, letter.envelope.from, state, letterId, receivedAt],
    );
    this.log.info("participation:recorded", {
      thread: letter.envelope.thread,
      address: letter.envelope.from,
      state,
    });
    return state;
  }

  /** The current participation state of an address in a thread. 'in' by
   *  default — the historical edges stand until a leave flips them. */
  async state(threadId: string, address: string): Promise<ParticipationState> {
    const { rows } = await this.pool.query<{ state: ParticipationState }>(
      `SELECT state FROM thread_participation
       WHERE thread_id = $1 AND address_id = $2`,
      [threadId, address],
    );
    return rows[0]?.state ?? "in";
  }

  /** Re-derive the participation cache from the leave/join letters
   *  (idempotent — the cache is rebuilt from the letters; the letters are
   *  the source of truth). Runs on demand; the house never needs a cron. */
  async reconcile(): Promise<void> {
    const { rows } = await this.pool.query<{
      thread_id: string;
      address_id: string;
      state: ParticipationState;
      since_letter_id: string;
      since_received_at: Date;
    }>(
      `SELECT DISTINCT ON (l.thread_id, l.from_addr)
              l.thread_id, l.from_addr AS address_id,
              CASE WHEN l.kind = 'leave' THEN 'out' ELSE 'in' END AS state,
              l.id AS since_letter_id, l.received_at AS since_received_at
       FROM letters l
       WHERE l.kind IN ('leave','join')
       ORDER BY l.thread_id, l.from_addr, l.received_at DESC`,
    );
    await this.pool.query("DELETE FROM thread_participation");
    for (const r of rows) {
      await this.pool.query(
        `INSERT INTO thread_participation
           (thread_id, address_id, state, since_letter_id, since_received_at)
         VALUES ($1, $2, $3, $4, $5)`,
        [r.thread_id, r.address_id, r.state, r.since_letter_id, r.since_received_at],
      );
    }
  }
}
