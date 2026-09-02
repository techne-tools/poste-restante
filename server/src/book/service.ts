/**
 * The house book — the commons made structural (SPEC §5.8).
 *
 * The book is a thread, not a table. A proposed norm is a letter to
 * book@house; the amendment is the correspondence; the book's head is the
 * current constitution, DERIVED from the thread, never declared by a keeper.
 *
 * This service is the rememberer: it reads the clause threads and derives
 * the head. It is never the author — every act is a letter, and the archive
 * keeps the history. Amendments are reversals, not erasures; "current" is
 * derived, not stored.
 *
 * The state machine (mechanical, stated will only):
 *
 *   proposal   → opens a thread; state=proposed, settling clock starts.
 *                May carry `reverses: <thread>` (a reversal proposal) and
 *                `binding: <door>: <value>` (a bound door).
 *   amendment  → continues a thread; new text, fresh settling clock,
 *                objections cleared (the objection was to the old text),
 *                vouches persist (the vouch is to the norm's direction).
 *   objection  → reopens as two voices; state=contested. Contested never
 *                stands. Distinct per resident — one objection per text.
 *   vouch      → distinct per resident; orders what the house SAYS, never
 *                what the house DOES.
 *   withdraw   → removes the resident's objection. Clearing the last
 *                objection restarts the settling clock (fresh settlement).
 *
 * Settling: a proposed clause stands when the settling period has passed
 * with no open objection. A reversal proposal that stands reverses its
 * target (the target must be standing). A reversed clause is terminal until
 * an amendment re-proposes it.
 *
 * Bound doors: a standing clause may bind a door (v1: pub@house.is_public).
 * The door is DERIVED from the book — the latest standing binding wins;
 * when a binding is reversed the door returns to its default (open). The
 * book only writes the door when a binding's state changed in this pass, so
 * it never fights a manual operator state while no binding stands.
 *
 * Commons by right: every resident reads the book. The book is NOT a
 * keyless door — guests are not residents; the book is the household's
 * knowing of itself.
 */
import type pg from "pg";
import type { Logger } from "../pipeline/logger.js";
import type { IngestionPipeline } from "../pipeline/pipeline.js";
import type { PostgresRepository } from "../db/repository.js";
import type { Letter, Frame } from "../types.js";
import {
  parseClauseFrontmatter,
  stripClauseFrontmatter,
  type ClauseFrontmatter,
} from "./frontmatter.js";

export const BOOK_ADDRESS = "book@house";

/** The only door a clause may bind in v1. The schema is unchanged if more
 *  doors are bound later — the door is a string, not a special case. */
export const PUB_DOOR = "pub@house.is_public";

export type ClauseState = "proposed" | "contested" | "standing" | "reversed";

export interface ClauseAction {
  role: "proposal" | "amendment" | "objection" | "vouch" | "withdraw";
  /** The thread this act continues. Required for every role except proposal. */
  amends?: string;
  /** On a proposal: the thread this proposal reverses when it stands. */
  reverses?: string;
  /** On a proposal/amendment: the door this clause binds when it stands. */
  binding?: { door: string; value: boolean };
  /** The clause text (the norm). Required for proposal/amendment. */
  text?: string;
}

export interface DerivedClause {
  thread: string;
  text: string;
  proposedBy: string;
  proposedIn: string;
  state: ClauseState;
  settlingFrom: Date;
  /** settlingFrom + settlingDays — the earliest moment the clause can stand. */
  settlesAt: Date;
  stoodAt: Date | null;
  reversedAt: Date | null;
  reversedIn: string | null;
  pendingReversal: boolean;
  reversesThread: string | null;
  objections: number;
  vouches: number;
  binding: { door: string; value: boolean } | null;
}

export interface BookHead {
  clauses: DerivedClause[];
  /** The doors currently bound by standing clauses, latest stood first. */
  doors: { door: string; value: boolean; boundBy: string }[];
  settlingDays: number;
}

/** The pure derivation — a clause thread's letters become its head. */
export function deriveClause(
  letters: Letter[],
  now: Date,
  settlingDays: number,
): DerivedClause | null {
  if (letters.length === 0) return null;

  let text = "";
  let proposedBy = "";
  let proposedIn = "";
  let state: ClauseState = "proposed";
  let settlingFrom = new Date(0);
  let pendingReversal = false;
  let reversesThread: string | null = null;
  let binding: { door: string; value: boolean } | null = null;
  const objectors = new Set<string>();
  const vouchers = new Set<string>();

  for (const letter of letters) {
    const fm = parseClauseFrontmatter(letter.body.content);
    if (!fm) continue; // a letter in the thread without frontmatter is prose, not an act
    const at = new Date(letter.time.gregorian);
    const letterId = letter.id ?? "";

    switch (fm.role) {
      case "proposal": {
        text = stripClauseFrontmatter(letter.body.content);
        proposedBy = letter.envelope.from;
        proposedIn = letterId;
        state = "proposed";
        settlingFrom = at;
        pendingReversal = Boolean(fm.reverses);
        reversesThread = fm.reverses ?? null;
        binding = fm.binding ?? null;
        objectors.clear();
        vouchers.clear();
        break;
      }
      case "amendment": {
        text = stripClauseFrontmatter(letter.body.content);
        proposedBy = letter.envelope.from;
        proposedIn = letterId;
        state = "proposed";
        settlingFrom = at;
        pendingReversal = false;
        reversesThread = null;
        if (fm.binding) binding = fm.binding;
        objectors.clear();
        break;
      }
      case "objection": {
        objectors.add(letter.envelope.from);
        if (state === "proposed") {
          state = "contested";
        }
        break;
      }
      case "vouch": {
        vouchers.add(letter.envelope.from);
        break;
      }
      case "withdraw": {
        objectors.delete(letter.envelope.from);
        if (objectors.size === 0 && state === "contested") {
          state = "proposed";
          settlingFrom = at; // fresh settlement — the objection is gone
        }
        break;
      }
    }
  }

  if (!proposedIn) return null; // no proposal ever — not a clause thread

  // Settling: proposed + settling period elapsed + no open objection.
  const settlesAt = new Date(settlingFrom.getTime() + settlingDays * 86_400_000);
  let stoodAt: Date | null = null;
  let reversedAt: Date | null = null;
  let reversedIn: string | null = null;
  if (state === "proposed" && now >= settlesAt) {
    stoodAt = settlesAt;
    // A reversal proposal that settles becomes a STANDING norm — "the pub
    // stays open" is the current norm. Its `reversesThread` marks it as a
    // reversal; the TARGET's reversal is derived cross-thread (a standing
    // reversal reverses its target), never declared here.
    state = "standing";
  }

  return {
    thread: letters[0]!.envelope.thread,
    text,
    proposedBy,
    proposedIn,
    state,
    settlingFrom,
    settlesAt,
    stoodAt,
    reversedAt,
    reversedIn,
    pendingReversal,
    reversesThread,
    objections: objectors.size,
    vouches: vouchers.size,
    binding,
  };
}

export class BookService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly pipeline: IngestionPipeline,
    private readonly repo: PostgresRepository,
    private readonly log: Logger,
    private readonly settlingDays: number,
  ) {}

  /**
   * Perform an act — write the clause letter (the act IS the letter; the
   * archive keeps the history), then derive the head and apply any door
   * the changed state binds. Returns the letter id and the derived clause.
   */
  async act(who: string, action: ClauseAction): Promise<{ letterId: string; clause: DerivedClause }> {
    const thread = action.amends ?? `th_clause_${crypto.randomUUID().slice(0, 8)}`;
    const fm: ClauseFrontmatter = { role: action.role };
    if (action.amends) fm.amends = action.amends;
    if (action.reverses) fm.reverses = action.reverses;
    if (action.binding) fm.binding = action.binding;

    const lines = ["```clause", `role: ${action.role}`];
    if (action.amends) lines.push(`amends: ${action.amends}`);
    if (action.reverses) lines.push(`reverses: ${action.reverses}`);
    if (action.binding) lines.push(`binding: ${action.binding.door}: ${action.binding.value}`);
    lines.push("```", "");
    lines.push(action.text ?? "");

    const letter: Letter = {
      envelope: {
        from: who,
        to: [BOOK_ADDRESS],
        cc: [],
        thread,
        kind: "clause",
        lang: "en-AU",
        subject: `clause: ${action.role}`,
      },
      time: { gregorian: new Date().toISOString(), frames: [] },
      body: { format: "markdown", content: lines.join("\n") },
    };

    const { letterId } = await this.pipeline.ingest(letter);
    const clause = await this.deriveThread(thread);
    if (!clause) throw new Error("the book could not derive this clause");
    return { letterId, clause };
  }

  /** Re-derive one clause thread from its letters (idempotent — the cache
   *  is rebuilt from the thread; the thread is the source of truth). */
  async deriveThread(threadId: string): Promise<DerivedClause | null> {
    const letters = await this.loadThreadLetters(threadId);
    const derived = deriveClause(letters, new Date(), this.settlingDays);
    if (!derived) return null;
    await this.persist(derived);
    await this.applyDoor([threadId]);
    return derived;
  }

  /** Re-derive every clause thread. Runs on read so settling is always
   *  current — the house holds; it never needs a cron to remember. */
  async deriveAll(): Promise<DerivedClause[]> {
    const { rows } = await this.pool.query<{ thread_id: string }>(
      `SELECT DISTINCT thread_id FROM letters WHERE kind = 'clause'`,
    );
    const changed: string[] = [];
    const out: DerivedClause[] = [];
    for (const { thread_id } of rows) {
      const letters = await this.loadThreadLetters(thread_id);
      const derived = deriveClause(letters, new Date(), this.settlingDays);
      if (!derived) continue;
      const prev = await this.getClause(thread_id);
      await this.persist(derived);
      if (prev && prev.state !== derived.state) changed.push(thread_id);
      out.push(derived);
    }
    // Cross-thread reversal: a standing reversal reverses its target. The
    // target's reversal is derived, never declared — the archive keeps the
    // history, "current" is derived.
    for (const clause of out) {
      if (clause.state === "standing" && clause.reversesThread) {
        const target = out.find((c) => c.thread === clause.reversesThread);
        if (target && target.state === "standing") {
          const prev = await this.getClause(target.thread);
          await this.pool.query(
            `UPDATE clauses
             SET state = 'reversed', reversed_at = $2, reversed_in = $3
             WHERE thread_id = $1`,
            [target.thread, clause.stoodAt ?? new Date(), clause.proposedIn],
          );
          if (prev && prev.state !== "reversed") changed.push(target.thread);
          target.state = "reversed";
          target.reversedAt = clause.stoodAt ?? new Date();
          target.reversedIn = clause.proposedIn;
        }
      }
    }
    await this.applyDoor(changed);
    return out;
  }

  /** The book's head — the derived constitution, plus the doors it binds. */
  async head(): Promise<BookHead> {
    const clauses = await this.deriveAll();
    const { rows } = await this.pool.query<{
      thread_id: string;
      binding_door: string;
      binding_value: boolean;
      stood_at: Date;
    }>(
      `SELECT thread_id, binding_door, binding_value, stood_at
       FROM clauses
       WHERE state = 'standing' AND binding_door IS NOT NULL
       ORDER BY stood_at DESC`,
    );
    return {
      clauses,
      doors: rows.map((r) => ({
        door: r.binding_door!,
        value: r.binding_value!,
        boundBy: r.thread_id,
      })),
      settlingDays: this.settlingDays,
    };
  }

  /**
   * The bound door — the only mechanics. When a binding clause's state
   * changed in this pass, the door is derived from the book: the latest
   * standing binding wins; when the last binding is reversed the door
   * returns to its default (open). The book never writes the door while no
   * binding changed — a manual operator state stands until the household
   * binds the door.
   */
  private async applyDoor(changedThreads: string[]): Promise<void> {
    if (changedThreads.length === 0) return;
    const { rows } = await this.pool.query<{
      thread_id: string;
      binding_door: string;
      binding_value: boolean;
      stood_at: Date;
    }>(
      `SELECT thread_id, binding_door, binding_value, stood_at
       FROM clauses
       WHERE state = 'standing' AND binding_door IS NOT NULL
       ORDER BY stood_at DESC`,
    );
    const latest = rows[0];
    if (!latest) {
      // No standing binding — the door returns to its default (open).
      const current = await this.repo.getAddress("pub@house");
      if (current && !current.is_public) {
        await this.repo.setPublic("pub@house", true);
        this.log.info("book:door", { door: PUB_DOOR, value: true, boundBy: null });
      }
      return;
    }
    const current = await this.repo.getAddress("pub@house");
    if (current && current.is_public !== latest.binding_value) {
      await this.repo.setPublic("pub@house", latest.binding_value);
      this.log.info("book:door", {
        door: latest.binding_door,
        value: latest.binding_value,
        boundBy: latest.thread_id,
      });
    }
  }

  private async loadThreadLetters(threadId: string): Promise<Letter[]> {
    const { rows } = await this.pool.query<{
      id: string;
      from_addr: string;
      to_addrs: string[];
      cc_addrs: string[];
      thread_id: string;
      kind: string;
      lang: string;
      subject: string;
      body: string;
      received_at: Date;
    }>(
      `SELECT id, from_addr, to_addrs, cc_addrs, thread_id, kind, lang, subject,
              body, received_at
       FROM letters
       WHERE thread_id = $1 AND kind = 'clause'
       ORDER BY received_at ASC`,
      [threadId],
    );
    return rows.map((r) => ({
      id: r.id,
      envelope: {
        from: r.from_addr,
        to: r.to_addrs,
        cc: r.cc_addrs,
        thread: r.thread_id,
        kind: r.kind as Letter["envelope"]["kind"],
        lang: r.lang,
        subject: r.subject,
      },
      time: { gregorian: r.received_at.toISOString(), frames: [] as Frame[] },
      body: { format: "markdown", content: r.body },
    }));
  }

  private async getClause(threadId: string): Promise<DerivedClause | null> {
    const { rows } = await this.pool.query<{
      thread_id: string;
      text: string;
      proposed_by: string;
      proposed_in: string;
      state: string;
      settling_from: Date;
      stood_at: Date | null;
      reversed_at: Date | null;
      reversed_in: string | null;
      pending_reversal: boolean;
      reverses_thread: string | null;
      objections: number;
      vouches: number;
      binding_door: string | null;
      binding_value: boolean | null;
    }>(
      `SELECT thread_id, text, proposed_by, proposed_in, state, settling_from,
              stood_at, reversed_at, reversed_in, pending_reversal,
              reverses_thread, objections, vouches, binding_door, binding_value
       FROM clauses WHERE thread_id = $1`,
      [threadId],
    );
    const r = rows[0];
    if (!r) return null;
    return {
      thread: r.thread_id,
      text: r.text,
      proposedBy: r.proposed_by,
      proposedIn: r.proposed_in,
      state: r.state as ClauseState,
      settlingFrom: r.settling_from,
      settlesAt: new Date(r.settling_from.getTime() + this.settlingDays * 86_400_000),
      stoodAt: r.stood_at,
      reversedAt: r.reversed_at,
      reversedIn: r.reversed_in,
      pendingReversal: r.pending_reversal,
      reversesThread: r.reverses_thread,
      objections: r.objections,
      vouches: r.vouches,
      binding: r.binding_door
        ? { door: r.binding_door, value: r.binding_value ?? false }
        : null,
    };
  }

  private async persist(derived: DerivedClause): Promise<void> {
    await this.pool.query(
      `INSERT INTO clauses
         (thread_id, text, proposed_by, proposed_in, state, settling_from,
          stood_at, reversed_at, reversed_in, pending_reversal, reverses_thread,
          objections, vouches, binding_door, binding_value)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)
       ON CONFLICT (thread_id) DO UPDATE SET
         text = EXCLUDED.text,
         proposed_by = EXCLUDED.proposed_by,
         proposed_in = EXCLUDED.proposed_in,
         state = EXCLUDED.state,
         settling_from = EXCLUDED.settling_from,
         stood_at = EXCLUDED.stood_at,
         reversed_at = EXCLUDED.reversed_at,
         reversed_in = EXCLUDED.reversed_in,
         pending_reversal = EXCLUDED.pending_reversal,
         reverses_thread = EXCLUDED.reverses_thread,
         objections = EXCLUDED.objections,
         vouches = EXCLUDED.vouches,
         binding_door = EXCLUDED.binding_door,
         binding_value = EXCLUDED.binding_value`,
      [
        derived.thread,
        derived.text,
        derived.proposedBy,
        derived.proposedIn,
        derived.state,
        derived.settlingFrom,
        derived.stoodAt,
        derived.reversedAt,
        derived.reversedIn,
        derived.pendingReversal,
        derived.reversesThread,
        derived.objections,
        derived.vouches,
        derived.binding?.door ?? null,
        derived.binding?.value ?? null,
      ],
    );
  }
}
