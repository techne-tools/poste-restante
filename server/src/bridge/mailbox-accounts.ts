/**
 * Mailbox accounts (SPEC §5 #12) — which residents have a mailbox, and where.
 *
 * The sync drive's subject. An account row is the ONLY thing that makes a
 * resident's mailbox sync — no row, no sync, no connection. The drive
 * enumerates accounts and syncs only those; it never scans addresses
 * (privacy as schema — same discipline as the gap scheduler's resident
 * enumeration).
 *
 * Each account carries a `url` — the resident's sidecar IMAP URL with a
 * sidecar-specific credential (minted once, printed once, exactly like an
 * invite code; the B1 design note: "sidecar-specific secrets, not the house
 * password"). The house stores that secret because the house is the one who
 * speaks IMAP with it — but it is per-resident, per-sidecar, and never the
 * resident's house credential.
 */
import type pg from "pg";

export interface MailboxAccount {
  address: string;
  url: string;
  createdAt: Date;
}

export class MailboxAccountsService {
  constructor(private readonly pool: pg.Pool) {}

  /** Provision a resident's mailbox account. Idempotent: re-adding the
   *  same address replaces its URL (re-minting a sidecar secret). */
  async add(address: string, url: string): Promise<void> {
    await this.pool.query(
      `INSERT INTO mailbox_accounts (address, url) VALUES ($1, $2)
       ON CONFLICT (address) DO UPDATE SET url = EXCLUDED.url`,
      [address, url],
    );
  }

  /** List every provisioned mailbox account, oldest first. */
  async list(): Promise<MailboxAccount[]> {
    const { rows } = await this.pool.query<{
      address: string;
      url: string;
      created_at: Date;
    }>(
      `SELECT address, url, created_at
       FROM mailbox_accounts
       ORDER BY created_at ASC`,
    );
    return rows.map((r) => ({ address: r.address, url: r.url, createdAt: r.created_at }));
  }

  /** Remove a resident's mailbox account. The drive stops syncing them;
   *  the sidecar keeps what it holds (the view re-materialises if the
   *  account is re-provisioned). */
  async remove(address: string): Promise<boolean> {
    const res = await this.pool.query(
      `DELETE FROM mailbox_accounts WHERE address = $1`,
      [address],
    );
    return (res.rowCount ?? 0) > 0;
  }
}
