/**
 * Retrieval — three paths, merged by RRF (reciprocal rank fusion).
 *
 *   * Exact     — postgres query on envelope ("the letter from ben on the 29th")
 *   * Full-text — postgres FTS ("the letter where we discussed the sound design")
 *   * Semantic  — qdrant vector similarity ("the letter where we were worried about the show")
 *
 * Ranking uses the house's own signals: recency (gentle decay), thread weight,
 * correspondent weight, frame match, explicit pins. NEVER engagement, virality,
 * or "you might also like".
 */
import type pg from "pg";
import type { SemanticStore } from "../qdrant/store.js";
import type { Embedder } from "../embed/embedder.js";
import type { LetterKind } from "../types.js";

export interface RetrievalQuery {
  /** Free-text query for FTS and semantic paths. */
  text?: string;
  /** Exact envelope filters. */
  from?: string;
  to?: string;
  thread?: string;
  kind?: LetterKind;
  /** A frame to match, e.g. `production:tempest-2026`. */
  frame?: string;
  /** Only pinned letters. */
  pinned?: boolean;
  /** Limit on the merged result. */
  limit?: number;
}

export interface RetrievalHit {
  letterId: string;
  /** The merged RRF score. */
  score: number;
  /** Which paths contributed to this hit. */
  paths: string[];
  /** The per-path ranks that fed the fusion. */
  ranks: Record<string, number>;
}

const DEFAULT_LIMIT = 20;

/**
 * Reciprocal rank fusion. Each path produces an ordered list of letter ids; the
 * fused score of a letter is the sum of 1/(k + rank) over every path that
 * returned it. k=60 is the standard constant. Robust, ~50 lines, and a fourth
 * path can be added without re-tuning.
 */
export function rrf(
  rankedLists: { path: string; ids: string[] }[],
  k = 60,
): Map<string, { score: number; paths: string[]; ranks: Record<string, number> }> {
  const fused = new Map<
    string,
    { score: number; paths: string[]; ranks: Record<string, number> }
  >();
  for (const list of rankedLists) {
    list.ids.forEach((id, idx) => {
      const rank = idx + 1;
      const entry = fused.get(id) ?? { score: 0, paths: [], ranks: {} };
      entry.score += 1 / (k + rank);
      entry.paths.push(list.path);
      entry.ranks[list.path] = rank;
      fused.set(id, entry);
    });
  }
  return fused;
}

export class Retrieval {
  constructor(
    private readonly pool: pg.Pool,
    private readonly semantic: SemanticStore,
    private readonly embedder: Embedder,
  ) {}

  /** Exact path: postgres query on envelope fields. */
  private async exact(query: RetrievalQuery): Promise<string[]> {
    const conds: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (query.from) {
      conds.push(`l.from_addr = $${i++}`);
      params.push(query.from);
    }
    if (query.to) {
      conds.push(`$${i++} = ANY(l.to_addrs)`);
      params.push(query.to);
    }
    if (query.thread) {
      conds.push(`l.thread_id = $${i++}`);
      params.push(query.thread);
    }
    if (query.kind) {
      conds.push(`l.kind = $${i++}`);
      params.push(query.kind);
    }
    if (query.frame) {
      conds.push(`EXISTS (
        SELECT 1 FROM letter_frames lf JOIN frames f ON f.id = lf.frame_id
        WHERE lf.letter_id = l.id AND f.id = $${i++})`);
      params.push(query.frame);
    }
    if (query.pinned) {
      conds.push(`l.pinned_at IS NOT NULL`);
    }
    if (conds.length === 0) return [];

    const where = conds.join(" AND ");
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT l.id FROM letters l WHERE ${where}
       ORDER BY l.received_at DESC LIMIT $${i}`,
      [...params, query.limit ?? DEFAULT_LIMIT],
    );
    return rows.map((r) => r.id);
  }

  /** Full-text path: postgres FTS on the plain-text body. */
  private async fullText(text: string, limit: number): Promise<string[]> {
    const { rows } = await this.pool.query<{ id: string }>(
      `SELECT l.id FROM letters l
       WHERE to_tsvector('english', l.body_text) @@ plainto_tsquery('english', $1)
       ORDER BY ts_rank(to_tsvector('english', l.body_text), plainto_tsquery('english', $1)) DESC
       LIMIT $2`,
      [text, limit],
    );
    return rows.map((r) => r.id);
  }

  /** Semantic path: qdrant vector similarity. */
  private async semanticPath(text: string, limit: number): Promise<string[]> {
    const vector = await this.embedder.embed(text);
    const hits = await this.semantic.search(vector, limit);
    return hits.map((h) => h.letterId);
  }

  /**
   * Merge the three paths by RRF, then apply the house's own ranking signals as
   * a gentle re-rank: recency decay, thread weight, correspondent weight, frame
   * match, explicit pins. This is a soft boost, not a replacement for RRF.
   */
  async search(query: RetrievalQuery): Promise<RetrievalHit[]> {
    const limit = query.limit ?? DEFAULT_LIMIT;

    const rankedLists: { path: string; ids: string[] }[] = [];
    rankedLists.push({ path: "exact", ids: await this.exact(query) });
    if (query.text) {
      rankedLists.push({ path: "fulltext", ids: await this.fullText(query.text, limit) });
      rankedLists.push({ path: "semantic", ids: await this.semanticPath(query.text, limit) });
    }

    const fused = rrf(rankedLists);
    const hits: RetrievalHit[] = [];
    for (const [letterId, entry] of fused) {
      hits.push({ letterId, score: entry.score, paths: entry.paths, ranks: entry.ranks });
    }

    // House ranking signals — a gentle re-rank of the fused set.
    const boosted = await this.applyHouseSignals(hits, query);
    boosted.sort((a, b) => b.score - a.score);
    return boosted.slice(0, limit);
  }

  /**
   * Apply the house's own ranking signals. Each signal is a small additive
   * boost to the RRF score. Recency uses a gentle exponential decay over days.
   */
  private async applyHouseSignals(
    hits: RetrievalHit[],
    query: RetrievalQuery,
  ): Promise<RetrievalHit[]> {
    if (hits.length === 0) return hits;

    const ids = hits.map((h) => h.letterId);
    const { rows } = await this.pool.query<{
      id: string;
      received_at: Date;
      pinned_at: Date | null;
      thread_id: string;
      thread_count: string;
      correspondent_count: string;
      frame_match: boolean;
    }>(
      `SELECT l.id, l.received_at, l.pinned_at, l.thread_id,
              (SELECT count(*) FROM letters l2 WHERE l2.thread_id = l.thread_id)::text AS thread_count,
              (SELECT count(*) FROM letter_addresses la WHERE la.letter_id = l.id)::text AS correspondent_count,
              $2::boolean AS frame_match
       FROM letters l
       WHERE l.id = ANY($1)
         AND ($2::boolean = false OR EXISTS (
              SELECT 1 FROM letter_frames lf JOIN frames f ON f.id = lf.frame_id
              WHERE lf.letter_id = l.id AND f.id = $3))`,
      [ids, query.frame ? true : false, query.frame ?? ""],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    const now = Date.now();
    const DAY = 24 * 60 * 60 * 1000;
    for (const hit of hits) {
      const row = byId.get(hit.letterId);
      if (!row) continue;

      // Recency: gentle exponential decay. A letter today gets +0.5; a letter
      // 30 days old gets ~+0.25; a year old ~+0.05. Never zero, never dominant.
      const ageDays = Math.max(0, (now - row.received_at.getTime()) / DAY);
      hit.score += 0.5 * Math.exp(-ageDays / 30);

      // Thread weight: a thread with more letters is a richer correspondence.
      const threadCount = Number(row.thread_count);
      hit.score += Math.min(0.3, threadCount * 0.02);

      // Correspondent weight: more correspondents = a wider conversation.
      const corrCount = Number(row.correspondent_count);
      hit.score += Math.min(0.2, corrCount * 0.02);

      // Frame match: the query asked for a frame and this letter is in it.
      if (query.frame && row.frame_match) hit.score += 0.4;

      // Explicit pin: a pinned letter is the strongest house signal.
      if (row.pinned_at) hit.score += 0.5;
    }
    return hits;
  }
}
