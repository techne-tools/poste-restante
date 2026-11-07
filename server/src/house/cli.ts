/**
 * The house's keypair — operator commands.
 *
 *   npm run house:key:init              provision, or export a database that
 *                                       still carries the private halves
 *   npm run house:key:show              print the PUBLIC halves (safe to share)
 *   npm run house:key:check             prove the secret matches the database
 *   npm run house:key:export            move the private halves out of an
 *                                       un-upgraded database (init does this)
 *   npm run house:key:forget-db-halves  empty the deprecated columns, once the
 *                                       secret store is proven to hold them
 *
 * The split this file enforces (PLAN-crypto.md C2): the database gets the
 * PUBLIC halves, the secret store gets the PRIVATE ones. `init` therefore
 * writes `containers/poste-restante/.env.house-key` — a 0600 plaintext seed
 * that the operator encrypts into `.env.enc` (sops + age) and then shreds. It
 * writes the secret BEFORE the row, because the secret is the half that cannot
 * be regenerated; a crash between the two leaves a file to import, never a
 * row whose identity nobody holds.
 *
 * No command here ever prints a private half. `export` writes to a file, and
 * the file is the thing the operator is told to encrypt and destroy.
 *
 * The offline procedure — export, store, restore, and what losing it means —
 * is docs/RUNBOOK-house-key.md. Read it before running anything here against a
 * house that holds letters you care about.
 */
import { chmodSync, existsSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { connectDbAndMigrate } from "../db/index.js";
import { createLogger } from "../pipeline/logger.js";
import { loadConfig } from "../config.js";
import { loadDotEnv } from "../env.js";
import { generateHouseKeypair, type HouseKeypair } from "../crypto/keys.js";
import { HouseKeysService, HOUSE_KEY_RUNBOOK } from "./keys.js";

loadDotEnv();

/**
 * Where `init`/`export` stage the private halves. Resolved from this file, so
 * it holds from `src/` (tsx) and `dist/` (built) alike: three levels up is the
 * repo root, then the deployment package that owns the house's secrets.
 */
const DEFAULT_SECRET_FILE = fileURLToPath(
  new URL("../../../containers/poste-restante/.env.house-key", import.meta.url),
);

const argv = process.argv.slice(2);
const command = argv.find((a) => !a.startsWith("-")) ?? "show";
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const has = (name: string): boolean => argv.includes(`--${name}`);
const secretFile = flag("out") ?? process.env.HOUSE_KEY_SECRET_FILE ?? DEFAULT_SECRET_FILE;

const log = createLogger();
const config = loadConfig();
const db = await connectDbAndMigrate(config.databaseUrl);
const keys = new HouseKeysService(db.pool, log);

/**
 * Write the private halves to `path` as a dotenv seed, 0600, refusing to
 * overwrite anything (overwriting a key file destroys an identity). Returns
 * the path written.
 */
function writeSecretFile(key: HouseKeypair, how: string): string {
  if (existsSync(secretFile) && !has("force")) {
    throw new Error(
      `${secretFile} already exists — refusing to overwrite it (that file may be the ` +
        `only copy of a house key). Pass --out <path> for a different file, or --force ` +
        "if you are certain this one is disposable.",
    );
  }
  if (!existsSync(dirname(secretFile))) {
    throw new Error(
      `directory ${dirname(secretFile)} does not exist. Pass --out <path> to choose where ` +
        `the seed is written (see ${HOUSE_KEY_RUNBOOK}).`,
    );
  }
  const body = [
    "# poste-restante — the house's PRIVATE halves (house@house).",
    `# Written ${new Date().toISOString()} by \`npm run house:key:${how}\`.`,
    "#",
    "# This is the house's identity. It is the only copy outside your backups;",
    "# the database holds the public halves only. Anyone holding these two lines",
    "# can open every collaborative letter — seal it to a key you control.",
    "#",
    "# Next, and in this order:",
    "#   sops .env.enc          # add these two lines, save, quit",
    "#   shred -u <this file>",
    `# See ${HOUSE_KEY_RUNBOOK}.`,
    "",
    `HOUSE_AGE_IDENTITY=${key.ageIdentity}`,
    `HOUSE_ED25519_PRIVATE=${key.ed25519Private}`,
    "",
  ].join("\n");
  writeFileSync(secretFile, body, { encoding: "utf8", mode: 0o600 });
  chmodSync(secretFile, 0o600); // mode above only applies on creation
  return secretFile;
}

function printStoreInstructions(path: string): void {
  log.warn("house:key-secret-store", {
    wrote: path,
    next: [
      `sops ${dirname(path)}/.env.enc   # add the two lines, save`,
      `shred -u ${path}`,
      "then restart the house — it reads HOUSE_AGE_IDENTITY / HOUSE_ED25519_PRIVATE from the environment",
    ],
    runbook: HOUSE_KEY_RUNBOOK,
  });
}

try {
  if (command === "init") {
    const pub = await keys.publicHalves();
    if (!pub) {
      // Fresh house. The secret is written before the row: if anything fails
      // between the two, what survives is a file to import, not a row whose
      // identity nobody holds.
      const fresh = await generateHouseKeypair();
      const wrote = writeSecretFile(fresh, "init");
      const key = await keys.provision(fresh);
      log.info("house:key-init", {
        created: true,
        ageRecipient: key.ageRecipient,
        ed25519Public: key.ed25519Public,
      });
      printStoreInstructions(wrote);
    } else {
      // The row exists. Either the private halves are still in the deprecated
      // columns (the upgrade path) or they are only in the operator's backup.
      const legacy = await keys.legacyPrivateHalves();
      if (legacy) {
        const wrote = writeSecretFile(legacy, "init");
        log.info("house:key-exported-from-database", {
          ageRecipient: legacy.ageRecipient,
          ed25519Public: legacy.ed25519Public,
        });
        printStoreInstructions(wrote);
      } else {
        log.error("house:key-already-provisioned", {
          ageRecipient: pub.ageRecipient,
          ed25519Public: pub.ed25519Public,
          why:
            "the database has this house's public halves and no private halves — " +
            "they are in the secret store (.env.enc) or the backups, and nowhere else",
          remedy: `restore .env.enc; if it is lost the house needs a new identity — see ${HOUSE_KEY_RUNBOOK}`,
        });
        process.exitCode = 1;
      }
    }
  } else if (command === "export") {
    const legacy = await keys.legacyPrivateHalves();
    if (!legacy) {
      log.error("house:key-nothing-to-export", {
        why: "the private halves are not in the database — either they already left, or this house never held them",
        remedy: "npm run house:key:show  # compare the public halves with your secret store",
      });
      process.exitCode = 1;
    } else {
      printStoreInstructions(writeSecretFile(legacy, "export"));
    }
  } else if (command === "forget-db-halves") {
    // get() is the proof: it only succeeds when the environment holds a secret
    // that derives this row's public halves.
    await keys.forgetDbHalves();
    log.info("house:key-db-halves-forgotten", {
      why: "age_identity and ed25519_private are now NULL; the secret store is the only copy",
      verified: "the environment's secret derives this row's public halves",
    });
  } else if (command === "check") {
    const key = await keys.get(); // throws with the remedy when it cannot
    if (!key) {
      log.error("house:key-missing", { remedy: "npm run house:key:init" });
      process.exitCode = 1;
    } else {
      log.info("house:key-ok", {
        ageRecipient: key.ageRecipient,
        ed25519Public: key.ed25519Public,
        secret: "present in the environment and matched against the database",
      });
    }
  } else if (command === "show") {
    // Public halves only, so this works on a house whose secret is missing —
    // which is exactly when an operator needs to compare them with a backup.
    const pub = await keys.publicHalves();
    if (!pub) {
      log.error("house:key-missing", { remedy: "npm run house:key:init" });
      process.exitCode = 1;
    } else {
      log.info("house:key", { ageRecipient: pub.ageRecipient, ed25519Public: pub.ed25519Public });
    }
  } else {
    log.error("house:key:unknown-command", {
      command,
      expected: ["init", "show", "check", "export", "forget-db-halves"],
    });
    process.exitCode = 2;
  }
} catch (err) {
  // The service's errors are written to be read by an operator and carry no
  // key material; anything else is surfaced as a message only.
  log.error("house:key-failed", { message: err instanceof Error ? err.message : String(err) });
  process.exitCode = 1;
} finally {
  await db.close();
}
