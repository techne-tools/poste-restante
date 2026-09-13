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
  /** Sealed letters (SPEC §15). The body is ciphertext the house never
   *  reads; `sealed` is a column, not a runtime flag — the visibility /
   *  FTS / whisper paths branch on it structurally when they need to
   *  (the semantic layer already skips sealed bodies at ingest). */
  sealed: boolean;
  /** The ed25519 signature over the letter id. Null for unsealed
   *  letters — the house verifies on ingest and at rest, stores it, and
   *  serves it so the client can present it (public keys are public). */
  signature: string | null;
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
      const sealed = body.format === "sealed";
      await client.query(
        `INSERT INTO letters
          (id, from_addr, to_addrs, cc_addrs, thread_id, kind, lang, subject,
           body, body_text, received_at, sealed, signature)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
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
          sealed,
          sealed && body.format === "sealed" ? body.signature : null,
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

  /** List the address book — the social graph. Flat, no ranking. The
   *  public halves of any registered keys ride along (SPEC §15): an
   *  address with a key record carries its age recipient and ed25519
   *  public so correspondents can seal to it and verify its letters.
   *  The recovery age recipient rides too — a resident whose primary
   *  key is lost must still be reached by the off-box recovery key
   *  (the §15 backstop). Public keys are public; the absent key record
   *  for a legacy address is simply null. Agents are marked as
   *  instruments (SPEC §16) — shown flat, never ranked, flat in the
   *  same list. */
  async listAddresses(): Promise<
    {
      id: string;
      names: string[];
      pronouns: string | null;
      ageRecipient: string | null;
      ed25519Public: string | null;
      recoveryAgeRecipient: string | null;
      isAgent: boolean;
      sealDefault: boolean;
    }[]
  > {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.names, a.pronouns, a.seal_default AS "sealDefault",
              ak.age_recipient AS "ageRecipient", ak.ed25519_public AS "ed25519Public",
              ak.recovery_age_recipient AS "recoveryAgeRecipient",
              EXISTS (SELECT 1 FROM agents ag WHERE ag.address = a.id AND ag.died_at IS NULL) AS "isAgent"
       FROM addresses a
       LEFT JOIN address_keys ak ON ak.address = a.id AND ak.retired_at IS NULL
       ORDER BY a.id`,
    );
    return rows;
  }

  /** Get one address. Carries the public halves of any registered keys
   *  (SPEC §15) — same shape as the flat list. */
  async getAddress(
    id: string,
  ): Promise<{
    id: string;
    names: string[];
    pronouns: string | null;
    is_public: boolean;
    ageRecipient: string | null;
    ed25519Public: string | null;
    recoveryAgeRecipient: string | null;
    isAgent: boolean;
    sealDefault: boolean;
  } | null> {
    const { rows } = await this.pool.query(
      `SELECT a.id, a.names, a.pronouns, a.is_public, a.seal_default AS "sealDefault",
              ak.age_recipient AS "ageRecipient", ak.ed25519_public AS "ed25519Public",
              ak.recovery_age_recipient AS "recoveryAgeRecipient",
              EXISTS (SELECT 1 FROM agents ag WHERE ag.address = a.id AND ag.died_at IS NULL) AS "isAgent"
       FROM addresses a
       LEFT JOIN address_keys ak ON ak.address = a.id AND ak.retired_at IS NULL
       WHERE a.id = $1`,
      [id],
    );
    return rows[0] ?? null;
  }

  /** Get an address's current public key record (SPEC §15). Public keys
   *  are public — verification needs them; they are not secrets. Returns
   *  the current (non-retired) key, or null when the address has none. */
  async getAddressKey(
    address: string,
  ): Promise<{ age_recipient: string; ed25519_public: string; recovery_age_recipient: string | null } | null> {
    const { rows } = await this.pool.query(
      `SELECT age_recipient, ed25519_public, recovery_age_recipient
       FROM address_keys
       WHERE address = $1 AND retired_at IS NULL
       ORDER BY created_at DESC
       LIMIT 1`,
      [address],
    );
    return rows[0] ?? null;
  }

  /** Register an address's public key record (SPEC §15). Idempotent
   *  upsert on the address — a resident has one current key record. */
  async setAddressKey(
    address: string,
    keys: { ageRecipient: string; ed25519Public: string; recoveryAgeRecipient: string | null },
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO address_keys (address, age_recipient, ed25519_public, recovery_age_recipient)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (address) DO UPDATE
         SET age_recipient = $2, ed25519_public = $3, recovery_age_recipient = $4, retired_at = NULL`,
      [address, keys.ageRecipient, keys.ed25519Public, keys.recoveryAgeRecipient],
    );
  }

  /** Make the identity id durable (SPEC §19). After a resident registers
   *  keys, the address's identity IS the ed25519 fingerprint. */
  async setAddressIdentity(address: string, identityId: string): Promise<void> {
    await this.pool.query(
      `UPDATE addresses SET identity_id = $2 WHERE id = $1`,
      [address, identityId],
    );
  }

  /** Open or close an address's door. The house's visibility law reads this. */
  async setPublic(id: string, open: boolean): Promise<boolean> {
    const res = await this.pool.query(
      `UPDATE addresses SET is_public = $2 WHERE id = $1`,
      [id, open],
    );
    return (res.rowCount ?? 0) > 0;
  }

  /** Set an address's names, pronouns, and seal default (the address book
   *  is correctable; the desk's default is a preference the resident owns). */
  async updateAddress(
    id: string,
    names: string[],
    pronouns: string | null,
    sealDefault: boolean,
  ): Promise<void> {
    await this.pool.query(
      `UPDATE addresses SET names = $2, pronouns = $3, seal_default = $4 WHERE id = $1`,
      [id, names, pronouns, sealDefault],
    );
  }

  /** List all frames. */
  async listFrames(): Promise<{ id: string; name: string; value: string }[]> {
    const { rows } = await this.pool.query(
      `SELECT id, name, value FROM frames ORDER BY name, value`,
    );
    return rows;
  }

  /** List the letters in an address's mailbox, newest first. Letters in
   *  threads the resident has put away ('shelved') OR left ('out') are
   *  excluded — the thread is kept, the edges stand (or the leaver's
   *  edges dissolve into the history), but it is not offered in the
   *  mailbox. The archive still holds the history; the mailbox is where
   *  the correspondence is live. */
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
      WHERE (l.from_addr = $1 OR $1 = ANY(l.to_addrs) OR $1 = ANY(l.cc_addrs))
        AND NOT EXISTS (
          SELECT 1 FROM thread_participation tp
          WHERE tp.thread_id = l.thread_id
            AND tp.address_id = $1
            AND tp.state IN ('shelved', 'out')
        )
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

  /** The letters in a thread that an address SENT (from_addr = the address).
   *  The scrub's subject: the resident removes their own presence — letters
   *  they wrote. Letters merely addressed to them (the other party's words)
   *  stay: the house cannot delete what the resident does not own. */
  async listThreadForAddress(threadId: string, address: string): Promise<StoredLetterRow[]> {
    const { rows } = await this.pool.query<StoredLetterRow>(
      `SELECT l.*, COALESCE(
         (SELECT json_agg(json_build_object('frame', f.name, 'value', f.value))
          FROM letter_frames lf JOIN frames f ON f.id = lf.frame_id
          WHERE lf.letter_id = l.id), '[]'::json) AS frames
      FROM letters l
      WHERE l.thread_id = $1 AND l.from_addr = $2
      ORDER BY l.received_at ASC`,
      [threadId, address],
    );
    return rows;
  }

  /** Everything the house holds about a resident — the review surface
   *  (SPEC §19: "what the house holds about you"). Same derived
   *  visibility limb as every face (visibleToSql: participant AND
   *  currently-in-thread, or public), but NOT filtered by the shelf:
   *  a letter put away is still held by the house, and the resident
   *  must be able to see it here. Newest first, capped high enough for
   *  a record, not a mailbox. */
  async listLettersForReview(address: string, limit = 500): Promise<StoredLetterRow[]> {
    const { rows } = await this.pool.query<StoredLetterRow>(
      `SELECT l.*, COALESCE(
         (SELECT json_agg(json_build_object('frame', f.name, 'value', f.value))
          FROM letter_frames lf JOIN frames f ON f.id = lf.frame_id
          WHERE lf.letter_id = l.id), '[]'::json) AS frames
      FROM letters l
      WHERE ${visibleToSql(1)}
      ORDER BY l.received_at DESC
      LIMIT $2`,
      [address, limit],
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
   *  by default — an address with no leave/join/shelve letter has no row,
   *  and the historical edges stand. Returns a map thread_id → state. */
  async participationStates(
    threadIds: string[],
    address: string,
  ): Promise<Map<string, "in" | "out" | "shelved">> {
    if (threadIds.length === 0) return new Map();
    const { rows } = await this.pool.query<{ thread_id: string; state: "in" | "out" | "shelved" }>(
      `SELECT thread_id, state FROM thread_participation
       WHERE address_id = $1 AND thread_id = ANY($2)`,
      [address, threadIds],
    );
    return new Map(rows.map((r) => [r.thread_id, r.state]));
  }

  /** The letters the mailbox sync may materialise for a resident: every
   *  LIVELY letter visible to them (the house's one visibility rule —
   *  participant AND currently-in-the-thread, or public), oldest first,
   *  carrying the strongest honest thread-reply signal: the resident
   *  wrote another letter in the same thread. The sync is a live offer —
   *  a left thread must not leak back into an IMAP client, so 'out' and
   *  'shelved' threads are excluded here explicitly. The caller hands only
   *  these rows to the engine; the engine cannot leak a letter it is
   *  never given. */
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
        AND NOT EXISTS (
          SELECT 1 FROM thread_participation tp
          WHERE tp.thread_id = l.thread_id
            AND tp.address_id = $1
            AND tp.state IN ('out', 'shelved')
        )
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

  /** The day's cards — the resident's own, and any card scoped to them
   *  ('house' is every resident; 'group' is the participants of a group
   *  thread; 'address' is one address). Single items, not threads; the
   *  pub is NOT a valid scope — cards are household-facing by design. */
  async listDayCards(address: string): Promise<
    {
      id: string;
      text: string;
      scope: "house" | "group" | "address";
      scopeValue: string;
      frameId: string | null;
      createdBy: string;
      createdAt: string;
    }[]
  > {
    const { rows } = await this.pool.query(
      `SELECT dc.id, dc.text, dc.scope, dc.scope_value AS "scopeValue",
              dc.frame_id AS "frameId", dc.created_by AS "createdBy",
              dc.created_at AS "createdAt"
       FROM day_cards dc
       WHERE dc.scope = 'house'
          OR (dc.scope = 'address' AND dc.scope_value = $1)
          OR (dc.scope = 'group' AND EXISTS (
            SELECT 1 FROM letter_addresses la
            JOIN letters l ON l.id = la.letter_id
            WHERE l.thread_id = dc.scope_value AND la.address_id = $1
          ))
       ORDER BY dc.created_at DESC`,
      [address],
    );
    return rows;
  }

  /** Put a single item on the day. The scope is declared on the card —
   *  never the pub (a card is household-facing, not public). 'group' is a
   *  thread id: its participants see the card. */
  async createDayCard(
    id: string,
    text: string,
    scope: "house" | "group" | "address",
    scopeValue: string,
    frameId: string | null,
    createdBy: string,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO day_cards (id, text, scope, scope_value, frame_id, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [id, text, scope, scopeValue, frameId, createdBy],
    );
  }

  /** Remove a card. The creator may remove their own card; 'house' cards
   *  may be removed by the creator only — no admin, ever. */
  async deleteDayCard(id: string, address: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM day_cards WHERE id = $1 AND created_by = $2`,
      [id, address],
    );
    return (res.rowCount ?? 0) > 0;
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
