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
 * target thread (derived from letter_addresses — the social graph) AND
 * currently 'in' that thread (derived from the leave/join letters — the
 * structural stop). A leaver stops being offered the thread, and gaps are
 * not even created for it (convergent by construction). The house never
 * gossips about correspondence you are not party to, and you cannot open,
 * dismiss, or undismiss a whisper about someone else's thread. This is
 * privacy as schema: the visibility rule is derived, not a policy.
 *
 * Pair gaps (gap-contradiction, gap-uncited-connection, gap-echo) add a
 * second limb: the whisper is only visible to an address party to BOTH
 * letters in the pair. Surfacing "A connects to B" when you are not party
 * to B would leak that B exists — so the predicate requires both. The
 * detection writers are convergent by construction: they only create pairs
 * within the caller's own participation set, so a dead invisible whisper
 * cannot be created.
 *
 * Frame gaps (gap-unvisited-corner) add a third limb: the address must be
 * party to at least one letter in the target frame. The room's territory
 * is proven through the social graph — the house never whispers about a
 * room its resident has never entered.
 */
import type pg from "pg";
import type { Logger } from "../pipeline/logger.js";
import type { SemanticStore } from "../qdrant/store.js";
import type { Embedder } from "../embed/embedder.js";

/**
 * Tuning knobs for the semantic gaps (SPEC §2.4 #1, #4). Cosine thresholds
 * against the house's embedding model (nomic-embed-text by default). These
 * are starting points, not doctrine — the rehearsal will tune them.
 */
const ECHO_SCORE = 0.82; // the same thing said twice in different words
const CONNECTION_SCORE = 0.58; // shares ground without citing the other thread
/** The active cloud, not the archive: only the caller's recent letters seed the pass. */
const SEMANTIC_CANDIDATES = 20;
/** Neighbours considered per anchor letter. */
const SEMANTIC_HITS = 8;
/** The house offers a few, not exhaustively — generosity, not enumeration. */
const MAX_SEMANTIC_GAPS = 5;

export type WhisperKind =
  | "house-letter"
  | "gap-dormant-thread"
  | "gap-unanswered-question"
  | "gap-contradiction"
  | "gap-uncited-connection"
  | "gap-echo"
  | "gap-unvisited-corner";

export interface Whisper {
  id: string;
  letterId: string | null;
  kind: WhisperKind;
  targetThread: string | null;
  /**
   * The other letter in a pair gap. The pair is an interval: `letterId`
   * (the anchor — where the resident lands and writes back) and
   * `relatedLetterId` (the letter the house is connecting it to). Both
   * stay at full weight; the schema keeps them apart so the client cannot
   * merge them by accident. Null for single-letter/thread whispers.
   */
  relatedLetterId: string | null;
  /**
   * The room in a frame-scoped gap (gap-unvisited-corner). The corner is
   * a region of the frame's territory with no letters — the whisper is
   * anchored on the room itself, not on any one letter. Null otherwise.
   */
  targetFrame: string | null;
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
  related_letter_id: string | null;
  target_frame: string | null;
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
  relatedLetterId: r.related_letter_id,
  targetFrame: r.target_frame,
  summary: r.summary,
  reasoning: r.reasoning,
  createdAt: r.created_at,
  openedAt: r.opened_at,
  dismissedAt: r.dismissed_at,
  repliedAt: r.replied_at,
});

/**
 * The visibility predicate. A whisper is visible to an address iff the
 * address is a participant in the whisper's subject. Two shapes:
 *
 *   * Thread-scoped whispers (all kinds except the corner) carry a
 *     target_thread — visible iff the caller is a participant. Pair gaps
 *     add a second limb (party to BOTH letters); the room limb guards a
 *     thread whisper that also names a frame.
 *   * Frame-scoped whispers (gap-unvisited-corner) carry target_frame and
 *     NO thread — visible iff the caller is party to at least one letter
 *     in the room. The room's territory is proven through the social
 *     graph; the house never whispers about a room its resident has never
 *     entered, and never leaks the room's existence to outsiders.
 *
 * `w` is the whispers alias; `$1` is the address. The writers are
 * convergent by construction (thread writers set no frame; the corner
 * sets no thread), so exactly one branch applies per whisper.
 *
 * The whole disjunction is parenthesised: callers suffix their own AND
 * conditions (`AND w.dismissed_at IS NULL`), and OR binds looser than
 * AND — an ungrouped `a OR b AND c` would apply `c` only to `b`.
 */
const VISIBLE_TO = `
  (
    (
      w.target_thread IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM letters l
        JOIN letter_addresses la ON la.letter_id = l.id
        WHERE l.thread_id = w.target_thread
          AND la.address_id = $1
      )
      AND NOT EXISTS (
        SELECT 1 FROM thread_participation tp
        WHERE tp.thread_id = w.target_thread
          AND tp.address_id = $1
          AND tp.state = 'out'
      )
      AND (
        w.related_letter_id IS NULL
        OR EXISTS (
          SELECT 1 FROM letters l
          JOIN letter_addresses la ON la.letter_id = l.id
          WHERE l.id = w.related_letter_id
            AND la.address_id = $1
        )
      )
      AND (
        w.target_frame IS NULL
        OR EXISTS (
          SELECT 1 FROM letter_frames lf
          JOIN letter_addresses la ON la.letter_id = lf.letter_id
          WHERE lf.frame_id = w.target_frame
            AND la.address_id = $1
        )
      )
    )
    OR
    (
      w.target_frame IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM letter_frames lf
        JOIN letter_addresses la ON la.letter_id = lf.letter_id
        WHERE lf.frame_id = w.target_frame
          AND la.address_id = $1
      )
    )
  )`;

export class WhisperService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly log: Logger,
    private readonly semantic?: SemanticStore,
    private readonly embedder?: Embedder,
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
    const dormant = await this.pool.query<{ thread_id: string; subject: string | null }>(
      `SELECT t.id AS thread_id,
              (SELECT l2.subject FROM letters l2
               WHERE l2.thread_id = t.id
               ORDER BY l2.received_at DESC LIMIT 1) AS subject
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
         )
         AND NOT EXISTS (
           SELECT 1 FROM thread_participation tp
           WHERE tp.thread_id = t.id AND tp.address_id = $3 AND tp.state = 'out'
        )`,
      [
        new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
        new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
        address,
      ],
    );
    for (const row of dormant.rows) {
      const id = `gap-dormant:${row.thread_id}`;
      // The serif voice names the thread by its latest letter's subject —
      // a raw thread id is the machine's index, not the house's speech.
      const name = row.subject?.trim() || row.thread_id;
      const summary = `A correspondence has gone quiet — the last letter in “${name}” arrived more than a fortnight ago.`;
      const reasoning = `The last letter in ${row.thread_id} arrived more than 14 days ago, and the thread has at least two letters — a correspondence, not a one-off. The house holds it, quietly.`;
      await this.pool.query(
        `INSERT INTO whispers (id, kind, target_thread, summary, reasoning)
         VALUES ($1, 'gap-dormant-thread', $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, row.thread_id, summary, reasoning],
      );
      created.push({
        id,
        letterId: null,
        kind: "gap-dormant-thread",
        targetThread: row.thread_id,
        relatedLetterId: null,
        targetFrame: null,
        summary,
        reasoning,
        createdAt: now,
        openedAt: null,
        dismissedAt: null,
        repliedAt: null,
      });
    }

    // Unanswered question: a letter with a question mark, no reply in 7 days.
    // Only threads the address participates in.
    const questions = await this.pool.query<{ thread_id: string; subject: string | null }>(
      `SELECT DISTINCT l.thread_id,
              (SELECT l2.subject FROM letters l2
               WHERE l2.thread_id = l.thread_id
               ORDER BY l2.received_at DESC LIMIT 1) AS subject
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
         )
         AND EXISTS (
           SELECT 1 FROM letters l3
           JOIN letter_addresses la ON la.letter_id = l3.id
           WHERE l3.thread_id = l.thread_id AND la.address_id = $2
         )
         AND NOT EXISTS (
           SELECT 1 FROM thread_participation tp
           WHERE tp.thread_id = l.thread_id AND tp.address_id = $2 AND tp.state = 'out'
        )`,
      [new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000), address],
    );
    for (const row of questions.rows) {
      const id = `gap-question:${row.thread_id}`;
      const reasoning = `The most recent letter in ${row.thread_id} ends with a question, and nothing has been written back in 7 days. The house is not answering for you — it is holding the question open.`;
      const name = row.subject?.trim() || row.thread_id;
      const summary = `A question is waiting in “${name}” — unanswered for a week.`;
      await this.pool.query(
        `INSERT INTO whispers (id, kind, target_thread, summary, reasoning)
         VALUES ($1, 'gap-unanswered-question', $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, row.thread_id, summary, reasoning],
      );
      created.push({
        id,
        letterId: null,
        kind: "gap-unanswered-question",
        targetThread: row.thread_id,
        relatedLetterId: null,
        targetFrame: null,
        summary,
        reasoning,
        createdAt: now,
        openedAt: null,
        dismissedAt: null,
        repliedAt: null,
      });
    }

    // Two voices — two correspondents in one thread, within a frame. The
    // house cannot tell you they disagree; it can only tell you both stand
    // here, at full weight (DESIGN.md: "the house holds, it does not
    // adjudicate"). Being-with is not being-the-same-as (Nancy).
    // Convergent by construction: the active frames are derived from the
    // caller's own recent correspondence — the house never scans frames the
    // caller is not part of.
    const activeFrames = await this.pool.query<{ frame_id: string }>(
      `SELECT DISTINCT lf.frame_id
       FROM letters l
       JOIN letter_addresses la ON la.letter_id = l.id
       JOIN letter_frames lf ON lf.letter_id = l.id
       WHERE la.address_id = $1
         AND l.received_at > $2`,
      [address, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000)],
    );
    for (const { frame_id: activeFrame } of activeFrames.rows) {
      const twoVoices = await this.pool.query<
        { thread_id: string; anchor: string; related: string; subject: string | null }
      >(
        `SELECT l1.thread_id, l1.id AS anchor, l2.id AS related,
                (SELECT l3.subject FROM letters l3
                 WHERE l3.thread_id = l1.thread_id
                 ORDER BY l3.received_at DESC LIMIT 1) AS subject
         FROM letters l1
         JOIN letters l2 ON l2.thread_id = l1.thread_id AND l2.from_addr <> l1.from_addr
         JOIN letter_frames lf ON lf.letter_id = l1.id AND lf.frame_id = $1
         JOIN letter_frames lf2 ON lf2.letter_id = l2.id AND lf2.frame_id = lf.frame_id
         WHERE l1.from_addr = $2
           AND NOT EXISTS (
             SELECT 1 FROM whispers w
             WHERE w.kind = 'gap-contradiction'
               AND w.letter_id = l1.id AND w.related_letter_id = l2.id
           )`,
        [activeFrame, address],
      );
      for (const row of twoVoices.rows) {
        const id = `gap-two-voices:${row.thread_id}:${activeFrame}`;
        const name = row.subject?.trim() || row.thread_id;
        const summary = `Two voices in “${name}” within ${activeFrame} — both letters here, the space between them held.`;
        const reasoning = `One thread, two correspondents, both letters in the frame ${activeFrame}. The house holds the space between them; it does not resolve it.`;
        await this.pool.query(
          `INSERT INTO whispers (id, kind, letter_id, related_letter_id, target_thread, summary, reasoning)
           VALUES ($1, 'gap-contradiction', $2, $3, $4, $5, $6)
           ON CONFLICT (id) DO NOTHING`,
          [id, row.anchor, row.related, row.thread_id, summary, reasoning],
        );
        created.push({
          id,
          letterId: row.anchor,
          kind: "gap-contradiction",
          targetThread: row.thread_id,
          relatedLetterId: row.related,
          targetFrame: null,
          summary,
          reasoning,
          createdAt: now,
          openedAt: null,
          dismissedAt: null,
          repliedAt: null,
        });
      }
    }

    // The unvisited corner — a region of the frame's territory with no
    // letters (SKETCH.md: "the masque cluster is empty while every other
    // cluster has letters"). A frame the caller has worked in has gone
    // quiet 30 days, while at least one of the caller's OTHER frames moved
    // within a fortnight — the territory moves, this room doesn't. The
    // house is not telling you to go back; it is holding the empty room
    // open. Convergent by construction: only frames the caller is party to.
    const corners = await this.pool.query<{ frame_id: string }>(
      `SELECT DISTINCT lf.frame_id
       FROM letter_frames lf
       JOIN letter_addresses la ON la.letter_id = lf.letter_id
       WHERE la.address_id = $1
         AND NOT EXISTS (
           SELECT 1 FROM letter_frames lf2
           JOIN letters l2 ON l2.id = lf2.letter_id
           WHERE lf2.frame_id = lf.frame_id
             AND l2.received_at > $2
         )
         AND EXISTS (
           SELECT 1 FROM letters l3
           JOIN letter_frames lf3 ON lf3.letter_id = l3.id
           JOIN letter_addresses la3 ON la3.letter_id = l3.id
           WHERE la3.address_id = $1
             AND lf3.frame_id <> lf.frame_id
             AND l3.received_at > $3
         )
         AND NOT EXISTS (
           SELECT 1 FROM whispers w
           WHERE w.kind = 'gap-unvisited-corner'
             AND w.target_frame = lf.frame_id
             AND w.created_at > $4
         )`,
      [
        address,
        new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000),
        new Date(now.getTime() - 14 * 24 * 60 * 60 * 1000),
        new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000),
      ],
    );
    for (const row of corners.rows) {
      const id = `gap-corner:${row.frame_id}`;
      // The frame id IS the human plural-time address (name:value) — the
      // serif voice keeps it whole, like the two-Voices summary.
      const summary = `An unvisited corner — “${row.frame_id}” has gone quiet while the work moves elsewhere.`;
      const reasoning = `No letter in ${row.frame_id} for 30 days, while another of your frames moved within a fortnight. The house is not telling you to go back — it is holding the empty room open.`;
      await this.pool.query(
        `INSERT INTO whispers (id, kind, target_frame, summary, reasoning)
         VALUES ($1, 'gap-unvisited-corner', $2, $3, $4)
         ON CONFLICT (id) DO NOTHING`,
        [id, row.frame_id, summary, reasoning],
      );
      created.push({
        id,
        letterId: null,
        kind: "gap-unvisited-corner",
        targetThread: null,
        relatedLetterId: null,
        targetFrame: row.frame_id,
        summary,
        reasoning,
        createdAt: now,
        openedAt: null,
        dismissedAt: null,
        repliedAt: null,
      });
    }

    // The semantic pair gaps (uncited connection, echo) — one pass, two
    // thresholds. The active cloud, not the archive: the caller's recent
    // letters seed the pass, and neighbours are only kept when they are in
    // a different thread (an active correspondence of the caller's). The
    // same two letters never double-offer: an echo is the strongest
    // overlap, so it wins; a connection is the weaker.
    if (this.semantic && this.embedder) {
      const semantic = await this.pool.query<
        { id: string; thread_id: string; subject: string | null }
      >(
        `SELECT l.id, l.thread_id,
                (SELECT l3.subject FROM letters l3
                 WHERE l3.thread_id = l.thread_id
                 ORDER BY l3.received_at DESC LIMIT 1) AS subject
         FROM letters l
         JOIN letter_addresses la ON la.letter_id = l.id
         WHERE la.address_id = $1
           AND l.received_at > $2
         ORDER BY l.received_at DESC
         LIMIT $3`,
        [address, new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000), SEMANTIC_CANDIDATES],
      );

      // Fetch plain-text bodies for the candidates — qdrant keys on them,
      // and the reasoning must name both letters without leaking others.
      const bodies = await this.pool.query<{ id: string; body_text: string }>(
        `SELECT id, body_text FROM letters WHERE id = ANY($1)`,
        [semantic.rows.map((r) => r.id)],
      );
      const bodyBy = new Map(bodies.rows.map((b) => [b.id, b.body_text]));
      const byId = new Map(semantic.rows.map((r) => [r.id, r]));

      let createdSemantic = 0;
      const seenPairs = new Set<string>();
      for (const row of semantic.rows) {
        if (createdSemantic >= MAX_SEMANTIC_GAPS) break;
        const text = bodyBy.get(row.id);
        if (!text?.trim()) continue;
        const vector = await this.embedder.embed(text);
        const hits = await this.semantic.search(vector, SEMANTIC_HITS);
        for (const hit of hits) {
          if (hit.letterId === row.id) continue;
          // Different thread only: an echo inside the same thread is the
          // correspondence itself, not a gap. Compare threads via the
          // candidate rows — never trust id shapes (thread ids and letter
          // ids are different namespaces).
          const hitRow = byId.get(hit.letterId);
          if (!hitRow) continue; // in the candidate cloud, so the reasoner can name it
          if (hitRow.thread_id === row.thread_id) continue;
          // The pair is unordered: A↔B is one offer, never two. Canonical
          // key keeps the reverse pass from double-offering.
          const pairKey = [row.id, hit.letterId].sort().join(":");
          if (seenPairs.has(pairKey)) continue;
          if (hit.score >= ECHO_SCORE) {
            const id = `gap-echo:${row.id}:${hit.letterId}`;
            await this.insertPairGap(id, "gap-echo", row.id, hit.letterId, row);
            created.push(this.pairWhisper(id, "gap-echo", row.id, hit.letterId, row, now));
            seenPairs.add(pairKey);
            createdSemantic += 1;
            break; // this anchor's strongest neighbour is an echo — move on
          }
          if (hit.score >= CONNECTION_SCORE) {
            const id = `gap-uncited:${row.id}:${hit.letterId}`;
            await this.insertPairGap(id, "gap-uncited-connection", row.id, hit.letterId, row);
            created.push(this.pairWhisper(id, "gap-uncited-connection", row.id, hit.letterId, row, now));
            seenPairs.add(pairKey);
            createdSemantic += 1;
            break; // one distinct neighbour per anchor — generosity, quiet
          }
        }
      }
    }

    if (created.length > 0) {
      this.log.info("whisper:gaps", { count: created.length });
    }
    return created;
  }

  /** Insert a semantic pair gap (uncited connection or echo). */
  private async insertPairGap(
    id: string,
    kind: "gap-echo" | "gap-uncited-connection",
    anchorId: string,
    relatedId: string,
    row: { thread_id: string; subject: string | null },
  ): Promise<void> {
    const { summary, reasoning } = this.pairCopy(kind, row);
    await this.pool.query(
      `INSERT INTO whispers (id, kind, letter_id, related_letter_id, target_thread, summary, reasoning)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (id) DO NOTHING`,
      [id, kind, anchorId, relatedId, row.thread_id, summary, reasoning],
    );
  }

  /** The whisper shape for a semantic pair gap. */
  private pairWhisper(
    id: string,
    kind: "gap-echo" | "gap-uncited-connection",
    anchorId: string,
    relatedId: string,
    row: { thread_id: string; subject: string | null },
    now: Date,
  ): Whisper {
    const { summary, reasoning } = this.pairCopy(kind, row);
    return {
      id,
      letterId: anchorId,
      kind,
      targetThread: row.thread_id,
      relatedLetterId: relatedId,
      targetFrame: null,
      summary,
      reasoning,
      createdAt: now,
      openedAt: null,
      dismissedAt: null,
      repliedAt: null,
    };
  }

  /** The serif voice for the semantic pair gaps. */
  private pairCopy(
    kind: "gap-echo" | "gap-uncited-connection",
    row: { thread_id: string; subject: string | null },
  ): { summary: string; reasoning: string } {
    // The serif voice names the correspondence by its latest letter's
    // subject — a raw thread id is the machine's index, not the house's
    // speech. The machine's index stays in the reasoning, where it belongs.
    const name = row.subject?.trim() || row.thread_id;
    if (kind === "gap-echo") {
      return {
        summary: `The work is circling — a letter in “${name}” echoes another correspondence, said twice in different words.`,
        reasoning: `Two letters share their ground nearly word-for-word in meaning (threads ${row.thread_id} and another). The house is not saying either is redundant — it is saying the work has stopped moving.`,
      };
    }
    return {
      summary: `An uncited connection — a letter in “${name}” shares ground with another correspondence.`,
      reasoning: `A letter in ${row.thread_id} and a letter in a different thread stand close in meaning, yet neither cites the other. The house is not citing for you — it is holding the correspondence between them.`,
    };
  }
}
