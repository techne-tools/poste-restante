/**
 * Postgres repository. The archive spine operations: store letters, link
 * correspondents/threads/frames, query for retrieval, and delete.
 */
import type pg from "pg";
import type { Letter, StoredLetter } from "../types.js";

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

      // Addresses (the social graph).
      const addresses = new Set([envelope.from, ...envelope.to, ...envelope.cc]);
      for (const addr of addresses) {
        await client.query(
          `INSERT INTO addresses (id) VALUES ($1) ON CONFLICT (id) DO NOTHING`,
          [addr],
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

  /** List the address book — the social graph. Flat, no ranking. */
  async listAddresses(): Promise<{ id: string; names: string[]; pronouns: string | null }[]> {
    const { rows } = await this.pool.query(
      `SELECT id, names, pronouns FROM addresses ORDER BY id`,
    );
    return rows;
  }

  /** Get one address. */
  async getAddress(id: string): Promise<{ id: string; names: string[]; pronouns: string | null } | null> {
    const { rows } = await this.pool.query(
      `SELECT id, names, pronouns FROM addresses WHERE id = $1`,
      [id],
    );
    return rows[0] ?? null;
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
