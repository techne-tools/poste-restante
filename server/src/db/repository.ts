/**
 * Postgres repository. The archive spine operations: store letters, link
 * correspondents/threads/frames, query for retrieval, and delete.
 */
import type pg from "pg";
import type { Letter, StoredLetter } from "../types.js";
import { PUB_ADDRESS, visibleToSql } from "../auth/visibility.js";
import type { MailboxSyncSource } from "../bridge/sync.js";

export interface LetterRow {
  id: string;
  from_addr: string;
  to_addrs: string[];
  cc_addrs: string[];
  thread_id: string;
  kind: string;
  lang: string;
  subject: string;
  body: string;
  body_text: string;
  received_at: Date;
  pinned_at: Date | null;
  pinned_by: string | null;
}

export interface StoredLetterRow extends LetterRow {
  frames: { frame: string; value: string }[];
}

export class PostgresRepository {
  constructor(private readonly pool: pg.Pool) {}

  /** Ensure an address exists (the address book is the social graph). */
  async ensureAddress(address: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO addresses (id) VALUES ($1)
       ON CONFLICT (id) DO NOTHING`,
      [address],
    );
  }

  /** Ensure a thread exists. */
  async ensureThread(threadId: string, references: string[] = []): Promise<void> {
    await this.pool.query(
      `INSERT INTO threads (id, "references") VALUES ($1, $2)
       ON CONFLICT (id) DO NOTHING`,
      [threadId, references],
    );
  }

  /** Ensure a frame exists and return its id. */
  async ensureFrame(name: string, value: string): Promise<string> {
    const id = `${name}:${value}`;
    await this.pool.query(
      `INSERT INTO frames (id, name, value) VALUES ($1, $2, $3)
       ON CONFLICT (id) DO NOTHING`,
      [id, name, value],
    );
    return id;
  }

  /** Store a letter and all its links (correspondents, thread, frames). */
  async storeLetter(letter: StoredLetter): Promise<void> {
    const { id, envelope, receivedAt, body, bodyText } = letter;
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");

      // Addresses (the social graph). The pub's door default is OPEN when
      // the row is absent (materialised public); a deliberately-closed pub
      // is never reopened by incoming mail (DO NOTHING).
      const addresses = new Set([envelope.from, ...envelope.to, ...envelope.cc]);
      for (const addr of addresses) {
        await client.query(
          `INSERT INTO addresses (id, is_public) VALUES ($1, $2)
           ON CONFLICT (id) DO NOTHING`,
          [addr, addr === PUB_ADDRESS],
        );
      }
      // Thread.
      await client.query(
        `INSERT INTO threads (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
        [envelope.thread],
      );

      // The letter row.
      await client.query(
        `INSERT INTO letters
           (id, from_addr, to_addrs, cc_addrs, thread_id, kind, lang, subject,
            body, body_text, received_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)
         ON CONFLICT (id) DO NOTHING`,
        [
          id,
          envelope.from,
          envelope.to,
          envelope.cc,
          envelope.thread,
          envelope.kind,
          envelope.lang,
          envelope.subject,
          body.content,
          bodyText,
          receivedAt,
        ],
      );

      // Correspondent links.
      for (const addr of addresses) {
        const role = addr === envelope.from ? "from" : envelope.to.includes(addr) ? "to" : "cc";
        await client.query(
          `INSERT INTO letter_addresses (letter_id, address_id, role)
           VALUES ($1,$2,$3) ON CONFLICT DO NOTHING`,
          [id, addr, role],
        );
      }

      // Frame links.
      for (const f of letter.time.frames) {
        const frameId = await this.ensureFrame(f.frame, f.value);
        await client.query(
          `INSERT INTO letter_frames (letter_id, frame_id) VALUES ($1,$2)
           ON CONFLICT DO NOTHING`,
          [id, frameId],
        );
      }

      await client.query("COMMIT");
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  /** Get a letter by id, with its frames. */
  async getLetter(id: string): Promise<StoredLetterRow | null> {
    const { rows } = await this.pool.query<StoredLetterRow>(
      `SELECT l.*, COALESCE(
         (SELECT json_agg(json_build_object('frame', f.name, 'value', f.value))
          FROM letter_frames lf JOIN frames f ON f.id = lf.frame_id
          WHERE lf.letter_id = l.id), '[]'::json) AS frames
       FROM letters l WHERE l.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Delete a letter and all its links. No soft delete — the archive forgets. */
  async deleteLetter(id: string): Promise<boolean> {
    const res = await this.pool.query("DELETE FROM letters WHERE id = $1", [id]);
    return (res.rowCount ?? 0) > 0;
  }

  /** The payload catalog — what a letter carries beyond its body.
   *  Migration 016: the pointer layer for the MinIO tier. The name,
   *  content type, and size are schema properties so the house can say
   *  what a payload *is* without asking the object store; the bytes
   *  themselves stay in MinIO. The rows die with the letter
   *  (ON DELETE CASCADE) — no orphaned pointers, ever. */
  async listPayloads(letterId: string): Promise<
    { name: string; content_type: string; size: number }[]
  > {
    const { rows } = await this.pool.query(
      `SELECT name, content_type, size
       FROM letter_payloads
       WHERE letter_id = $1
       ORDER BY created_at ASC, name ASC`,
      [letterId],
    );
    return rows;
  }

  /** One catalog row — null when the letter carries no such payload. */
  async getPayload(
    letterId: string,
    name: string,
  ): Promise<{ name: string; content_type: string; size: number } | null> {
    const { rows } = await this.pool.query(
      `SELECT name, content_type, size
       FROM letter_payloads
       WHERE letter_id = $1 AND name = $2`,
      [letterId, name],
    );
    return rows[0] ?? null;
  }

  /** Record a stored payload in the catalog. */
  async insertPayload(
    letterId: string,
    name: string,
    content_type: string,
    size: number,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO letter_payloads (letter_id, name, content_type, size)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (letter_id, name) DO UPDATE
         SET content_type = EXCLUDED.content_type, size = EXCLUDED.size`,
      [letterId, name, content_type, size],
    );
  }

  /** Remove one catalog row. The bytes are the caller's concern. */
  async deletePayload(letterId: string, name: string): Promise<void> {
    await this.pool.query(
      `DELETE FROM letter_payloads WHERE letter_id = $1 AND name = $2`,
      [letterId, name],
    );
  }

  /** List the address book — the social graph. Flat, no ranking. */
  async listAddresses(): Promise<{ id: string; names: string[]; pronouns: string | null }[]> {
    const { rows } = await this.pool.query(
      `SELECT id, names, pronouns FROM addresses ORDER BY id`,
    );
    return rows;
  }

  /** Get one address. */
  async getAddress(id: string): Promise<{ id: string; names: string[]; pronouns: string | null; is_public: boolean } | null> {
    const { rows } = await this.pool.query(
      `SELECT id, names, pronouns, is_public FROM addresses WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Open or close an address's door. The house's visibility law reads this. */
  async setPublic(id: string, open: boolean): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE addresses SET is_public = $2 WHERE id = $1`,
      [id, open],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Set an address's names and pronouns (the address book is correctable). */
  async updateAddress(
    id: string,
    names: string[],
    pronouns: string | null,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE addresses SET names = $2, pronouns = $3 WHERE id = $1`,
      [id, names, pronouns],
    );
  }

  /** List all frames. */
  async listFrames(): Promise<{ id: string; name: string; value: string }[]> {
    const { rows } = await this.pool.query(
      `SELECT id, name, value FROM frames ORDER BY name, value`,
    );
    return rows;
  }

  /** List the letters in an address's mailbox, newest first. */
  async listMailbox(
    address: string,
    limit: number,
  ): Promise<StoredLetterRow[]> {
    const { rows } = await this.pool.query<StoredLetterRow>(
      `SELECT l.*, COALESCE(
         (SELECT json_agg(json_build_object('frame', f.name, 'value', f.value))
          FROM letter_frames lf JOIN frames f ON f.id = lf.frame_id
          WHERE lf.letter_id = l.id), '[]'::json) AS frames
       FROM letters l
       WHERE l.from_addr = $1 OR $1 = ANY(l.to_addrs) OR $1 = ANY(l.cc_addrs)
       ORDER BY l.received_at DESC
       LIMIT $2`,
      [address, limit],
    );
    return rows;
  }

  /** List the letters in a thread, oldest first (the correspondence). */
  async listThread(threadId: string): Promise<StoredLetterRow[]> {
    const { rows } = await this.pool.query<StoredLetterRow>(
      `SELECT l.*, COALESCE(
         (SELECT json_agg(json_build_object('frame', f.name, 'value', f.value))
          FROM letter_frames lf JOIN frames f ON f.id = lf.frame_id
          WHERE lf.letter_id = l.id), '[]'::json) AS frames
      FROM letters l
      WHERE l.thread_id = $1
      ORDER BY l.received_at ASC`,
      [threadId],
    );
    return rows;
  }

  /** The letters in a thread that an address is party to (from/to/cc). */
  async listThreadForAddress(threadId: string, address: string): Promise<StoredLetterRow[]> {
    const { rows } = await this.pool.query<StoredLetterRow>(
      `SELECT l.*, COALESCE(
         (SELECT json_agg(json_build_object('frame', f.name, 'value', f.value))
          FROM letter_frames lf JOIN frames f ON f.id = lf.frame_id
          WHERE lf.letter_id = l.id), '[]'::json) AS frames
      FROM letters l
      JOIN letter_addresses la ON la.letter_id = l.id
      WHERE l.thread_id = $1 AND la.address_id = $2
      ORDER BY l.received_at ASC`,
      [threadId, address],
    );
    return rows;
  }

  /** Fetch many letters by id, preserving the given order. */
  async getLetters(ids: string[]): Promise<StoredLetterRow[]> {
    if (ids.length === 0) return [];
    const { rows } = await this.pool.query<StoredLetterRow>(
      `SELECT l.*, COALESCE(
         (SELECT json_agg(json_build_object('frame', f.name, 'value', f.value))
          FROM letter_frames lf JOIN frames f ON f.id = lf.frame_id
          WHERE lf.letter_id = l.id), '[]'::json) AS frames
      FROM letters l
      WHERE l.id = ANY($1)`,
      [ids],
    );
    const byId = new Map(rows.map((r) => [r.id, r]));
    return ids.flatMap((id) => {
      const row = byId.get(id);
      return row ? [row] : [];
    });
  }

  /** The participation states of an address across a set of threads. 'in'
   *  by default — an address with no leave/join letter has no row, and the
   *  historical edges stand. Returns a map thread_id → state. */
  async participationStates(
    threadIds: string[],
    address: string,
  ): Promise<Map<string, "in" | "out">> {
    if (threadIds.length === 0) return new Map();
    const { rows } = await this.pool.query<{ thread_id: string; state: "in" | "out" }>(
      `SELECT thread_id, state FROM thread_participation
       WHERE address_id = $1 AND thread_id = ANY($2)`,
      [address, threadIds],
    );
    return new Map(rows.map((r) => [r.thread_id, r.state]));
  }

  /** The letters the mailbox sync may materialise for a resident: every
   *  letter visible to them (the house's one visibility rule — participant
   *  AND currently-in-the-thread, or public), oldest first, carrying the
   *  strongest honest thread-reply signal: the resident wrote another
   *  letter in the same thread. The caller hands only these rows to the
   *  engine; the engine cannot leak a letter it is never given. */
  async lettersForMailboxSync(address: string): Promise<MailboxSyncSource[]> {
    const { rows } = await this.pool.query<StoredLetterRow & { threadReplied: boolean }>(
      `SELECT l.*, COALESCE(
         (SELECT json_agg(json_build_object('frame', f.name, 'value', f.value))
          FROM letter_frames lf JOIN frames f ON f.id = lf.frame_id
          WHERE lf.letter_id = l.id), '[]'::json) AS frames,
       EXISTS (
         SELECT 1 FROM letters r
         WHERE r.thread_id = l.thread_id
           AND r.from_addr = $1
           AND r.id <> l.id
       ) AS "threadReplied"
       FROM letters l
       WHERE ${visibleToSql(1)}
       ORDER BY l.received_at ASC`,
      [address],
    );
    return rows.map((r) => ({
      letter: {
        id: r.id,
        from_addr: r.from_addr,
        to_addrs: r.to_addrs,
        cc_addrs: r.cc_addrs,
        thread_id: r.thread_id,
        kind: r.kind,
        lang: r.lang,
        subject: r.subject,
        body: r.body,
        body_text: r.body_text,
        received_at: r.received_at,
        pinned_at: r.pinned_at,
        frames: r.frames,
      },
      threadReplied: r.threadReplied,
    }));
  }

  /** The frame ids a resident has worked in, most recent window first
   *  (same derivation as the whisper's active frames — the house never
   *  scans frames the caller is not part of). Frame folder placement is a
   *  membership test, never an ordering; the letter's own frames win. */
  async activeFrameIds(address: string): Promise<string[]> {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    const { rows } = await this.pool.query<{ frame_id: string }>(
      `SELECT DISTINCT lf.frame_id
       FROM letters l
       JOIN letter_addresses la ON la.letter_id = l.id
       JOIN letter_frames lf ON lf.letter_id = l.id
       WHERE la.address_id = $1
         AND l.received_at > $2`,
      [address, cutoff],
    );
    return rows.map((r) => r.frame_id);
  }

  /** Pin a letter (explicit house ranking signal). */
  async pinLetter(id: string, pinnedBy: string): Promise<void> {
    await this.pool.query(
      `UPDATE letters SET pinned_at = now(), pinned_by = $2 WHERE id = $1`,
      [id, pinnedBy],
    );
  }

  /** Unpin a letter. */
  async unpinLetter(id: string): Promise<void> {
    await this.pool.query(
      `UPDATE letters SET pinned_at = NULL, pinned_by = NULL WHERE id = $1`,
      [id],
    );
  }
}
