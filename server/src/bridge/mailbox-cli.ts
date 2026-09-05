/**
 * Poste Restante — the mailbox accounts CLI (SPEC §5 #12, the sync drive).
 *
 *   npm run mailbox:add -- <address> <imap-url>    # provision a resident's mailbox
 *   npm run mailbox:list                            # list provisioned accounts (host only)
 *   npm run mailbox:remove -- <address>             # stop syncing a resident
 *
 * The owner mints a resident's mailbox account the same way they mint a
 * credential — sidecar-specific secret (minted once, printed once, exactly
 * like an invite code; never the house password). The URL carries the
 * sidecar credential in the userinfo (imap://user:pass@host:port/ or
 * imaps://), and the house stores that URL because the house is the one who
 * speaks IMAP with it.
 *
 * The list view is privacy-shaped: it prints the address and the server
 * host only — never the URL, never the credential in the userinfo.
 */
import { connectDbAndMigrate } from "../db/index.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../pipeline/logger.js";
import { MailboxAccountsService } from "./mailbox-accounts.js";
import { parseImapUrl } from "./imap-writer.js";

const USAGE = `usage:
  npm run mailbox:add -- <address> <imap-url>   provision a resident's mailbox
  npm run mailbox:list                          list provisioned accounts (host only)
  npm run mailbox:remove -- <address>           stop syncing a resident

  <imap-url> must be imap://user:pass@host:port/ or imaps://… — the
  sidecar-specific credential rides in the URL.`;

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return "<invalid>";
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const config = loadConfig(process.env);
  const db = await connectDbAndMigrate(config.databaseUrl);
  const log = createLogger();
  const accounts = new MailboxAccountsService(db.pool);

  try {
    if (command === "add") {
      const address = args[1];
      const url = args[2];
      if (!address || !url) throw new Error(USAGE);
      // Validate the URL eagerly — the house fails closed, never stores a
      // URL it cannot parse (parseImapUrl throws on non-imap schemes).
      parseImapUrl(url);
      await accounts.add(address, url);
      process.stdout.write(`mailbox provisioned for ${address} → ${hostOf(url)}\n`);
      process.stdout.write(
        `the sidecar credential was printed once and is stored in the house — ` +
          `re-mint it in the sidecar if it was ever shared.\n`,
      );
      return;
    }

    if (command === "list") {
      const rows = await accounts.list();
      if (rows.length === 0) {
        process.stdout.write("no mailbox accounts provisioned — the house does not sync.\n");
        return;
      }
      for (const row of rows) {
        process.stdout.write(`${row.address}\t${hostOf(row.url)}\t${row.createdAt.toISOString()}\n`);
      }
      return;
    }

    if (command === "remove") {
      const address = args[1];
      if (!address) throw new Error(USAGE);
      const removed = await accounts.remove(address);
      process.stdout.write(
        removed
          ? `removed ${address}'s mailbox account — the house stops syncing them.\n`
          : `${address} had no mailbox account.\n`,
      );
      return;
    }

    throw new Error(USAGE);
  } finally {
    await db.close();
    void log;
  }
}

main().catch((err) => {
  process.stderr.write(`mailbox: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
