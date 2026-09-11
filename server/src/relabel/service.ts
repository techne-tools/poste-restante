/**
 * RelabelService — the handle is a label, the identity is the key (SPEC §19).
 *
 * A resident may change their handle at will; the identity, the edges,
 * the letter ids, the trust — all unchanged. The letter id hashes the
 * identity (migration 022), the OIDC binding keys off the identity
 * (migration 023), and every FK referencing addresses(id) cascades on
 * UPDATE (migration 024) — so a relabel is a single UPDATE on
 * addresses.id that propagates structurally. No hand-written edge
 * updates, no drift.
 *
 * The act IS a letter: a `kind: "rename"` letter to the address book is
 * the archive's record of the change; the mechanism is the change. The
 * old handle is retired — never reused, never claimable (a deadname must
 * not become someone else's name).
 */
import type pg from "pg";
import type { Logger } from "../pipeline/logger.js";

export class RelabelService {
  constructor(
    private readonly pool: pg.Pool,
    private readonly log: Logger,
  ) {}

  /**
   * Relabel an address. The identity never changes; the handle does.
   * The old handle is retired. Returns false when the new handle is
   * already taken or the address does not exist.
   */
  async relabel(address: string, newHandle: string): Promise<boolean> {
    // The new handle must be free — and the old handle must not be a
    // retired deadname.
    const taken = await this.pool.query(
      `SELECT 1 FROM addresses WHERE id = $1
       UNION ALL
       SELECT 1 FROM retired_handles WHERE handle = $1
       LIMIT 1`,
      [newHandle],
    );
    if (taken.rows.length > 0) return false;

    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      // The relabel: identity_id stays, the handle changes. Every FK
      // referencing addresses(id) cascades on UPDATE (migration 024).
      const res = await client.query(
        `UPDATE addresses SET id = $2 WHERE id = $1`,
        [address, newHandle],
      );
      if ((res.rowCount ?? 0) === 0) {
        await client.query("ROLLBACK");
        return false;
      }
      // The stored letter envelope strings (from_addr, to_addrs, cc_addrs)
      // are plain text — the FKs cascade on the join edges, but the text
      // arrays do not. The archive must show the new handle everywhere the
      // old one was (SPEC §19): sweep every letter's stored strings in the
      // same transaction. Letter ids do NOT change — the id hashes the
      // identity (migration 022), and the identity just changed its label.
      await client.query(
        `UPDATE letters
         SET from_addr = CASE WHEN from_addr = $1 THEN $2 ELSE from_addr END,
             to_addrs = array_replace(to_addrs, $1, $2),
             cc_addrs = array_replace(cc_addrs, $1, $2)
         WHERE from_addr = $1 OR $1 = ANY(to_addrs) OR $1 = ANY(cc_addrs)`,
        [address, newHandle],
      );
      // The old handle is retired — a deadname must not become someone
      // else's name.
      await client.query(
        `INSERT INTO retired_handles (handle) VALUES ($1) ON CONFLICT DO NOTHING`,
        [address],
      );
      await client.query("COMMIT");
      this.log.info("address:relabeled", { from: address, to: newHandle });
      return true;
    } catch (err) {
      await client.query("ROLLBACK");
      this.log.error("address:relabel-failed", {
        from: address,
        to: newHandle,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    } finally {
      client.release();
    }
  }
}
