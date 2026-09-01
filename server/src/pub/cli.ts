/**
 * Poste Restante — the pub's door (the address's is_public flag).
 *
 *   npm run pub:door -- state           # print whether the pub is open
 *   npm run pub:door -- open            # open the pub to unauthenticated readers
 *   npm run pub:door -- close           # members-only: guests get 401
 *
 * The door is schema, not code (invariant 4): an UPDATE, not a deploy.
 * Closing answers guests like any private mailbox — absence is silence.
 * Residents always read the pub; only the keyless visitor is shut out.
 */
import { connectDbAndMigrate } from "../db/index.js";
import { loadConfig } from "../config.js";
import { PostgresRepository } from "../db/repository.js";
import { PUB_ADDRESS } from "../auth/visibility.js";

const USAGE = `usage:
  npm run pub:door -- state           print whether the pub is open
  npm run pub:door -- open            open the pub to unauthenticated readers
  npm run pub:door -- close           members-only: guests get 401`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const config = loadConfig(process.env);
  const db = await connectDbAndMigrate(config.databaseUrl);
  const repo = new PostgresRepository(db.pool);

  try {
    if (command === "state") {
      const pub = await repo.getAddress(PUB_ADDRESS);
      if (!pub) {
        process.stdout.write("the pub has no door — pub@house does not exist yet\n");
        return;
      }
      process.stdout.write(pub.is_public ? "open\n" : "closed\n");
      return;
    }
    if (command === "open" || command === "close") {
      const open = command === "open";
      const changed = await repo.setPublic(PUB_ADDRESS, open);
      if (!changed) {
        process.stdout.write("no such address — pub@house does not exist yet\n");
        process.exit(1);
      }
      process.stdout.write(`pub@house is now ${open ? "open" : "closed"} (members-only)\n`);
      return;
    }
    throw new Error(USAGE);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`pub:door failed: ${String(err)}\n`);
  process.exit(1);
});
