/**
 * The house's keypair — operator commands.
 *
 *   npm run house:key:init    provision the singleton (once; then back it up)
 *   npm run house:key:show    print the PUBLIC halves (safe to share)
 *
 * Never prints a private half. Provisioning is an explicit act because the
 * alternative — minting on boot — gives a restored database a new identity
 * and strands every collaborative letter sealed to the old one (see
 * `HouseKeyMissingError`).
 *
 * The private halves still live in the `house_keys` row; moving them to the
 * deployment's secret store is carded (PLAN-crypto.md, C2).
 */
import { connectDbAndMigrate } from "../db/index.js";
import { createLogger } from "../pipeline/logger.js";
import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import { HouseKeysService } from "./keys.js";

loadDotEnv();

const command = process.argv[2] ?? "show";
const config = loadConfig();
const log = createLogger();
const db = await connectDbAndMigrate(config.databaseUrl);
const keys = new HouseKeysService(db.pool, log);

try {
  if (command === "init") {
    const before = await keys.get();
    const key = await keys.provision();
    log.info("house:key-init", {
      created: before === null,
      ageRecipient: key.ageRecipient,
      ed25519Public: key.ed25519Public,
    });
    if (before === null) {
      log.warn("house:key-backup-now", {
        why: "the private halves live in the database — lose the row and every collaborative letter is unreadable",
      });
    }
  } else if (command === "show") {
    const key = await keys.get();
    if (!key) {
      log.error("house:key-missing", { remedy: "npm run house:key:init" });
      process.exitCode = 1;
    } else {
      log.info("house:key", {
        ageRecipient: key.ageRecipient,
        ed25519Public: key.ed25519Public,
      });
    }
  } else {
    log.error("house:key:unknown-command", {
      command,
      expected: ["init", "show"],
    });
    process.exitCode = 2;
  }
} finally {
  await db.close();
}
