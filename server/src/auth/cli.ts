/**
 * Poste Restante — the auth CLI.
 *
 *   npm run auth:add -- ben@house            # set a password (prompts)
 *   npm run auth:add -- ben@house --token    # issue a bearer token (shown once)
 *   npm run auth:list
 *   npm run auth:remove -- ben@house
 *
 * The owner issues credentials; the house never auto-creates identities.
 * A credential is a capability to act as an address — there is no admin
 * class, no roles. The first credential bootstraps the house.
 */
import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import { connectDbAndMigrate } from "../db/index.js";
import { AuthService } from "./service.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../pipeline/logger.js";

const USAGE = `usage:
  npm run auth:add -- <address> [--token]   set a password (prompts) or issue a token
  npm run auth:list                          list residents who can act
  npm run auth:remove -- <address>           remove a credential (address stays in the graph)`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const config = loadConfig(process.env);
  const db = await connectDbAndMigrate(config.databaseUrl);
  const auth = new AuthService(db.pool, createLogger(), config.auth);

  try {
    if (command === "add") {
      const address = args[1];
      if (!address) throw new Error(USAGE);
      const tokenMode = args.includes("--token");

      if (tokenMode) {
        const token = await auth.issueToken(address);
        process.stdout.write(`token issued for ${address}\n`);
        process.stdout.write(`\n  ${token}\n\n`);
        process.stdout.write(
          `show this once — it is stored only as a sha256 hash. ` +
            `Use it as: Authorization: Bearer <token>\n`,
        );
        return;
      }

      const rl = createInterface({ input: stdin, output: stdout });
      const password = await rl.question(`password for ${address}: `);
      const confirm = await rl.question("confirm: ");
      rl.close();
      if (password !== confirm) throw new Error("passwords do not match");
      if (password.length < 8) throw new Error("password must be at least 8 characters");
      await auth.setPassword(address, password);
      process.stdout.write(`password credential set for ${address}\n`);
      return;
    }

    if (command === "list") {
      const rows = await auth.listCredentials();
      if (rows.length === 0) {
        process.stdout.write("no credentials — the house has no residents who can act\n");
        return;
      }
      for (const r of rows) {
        process.stdout.write(`${r.address}\t${r.kind}${r.oidcSub ? `\toidc:${r.oidcSub}` : ""}\n`);
      }
      return;
    }

    if (command === "remove") {
      const address = args[1];
      if (!address) throw new Error(USAGE);
      const removed = await auth.removeCredential(address);
      process.stdout.write(
        removed
          ? `credential removed for ${address} (the address stays in the social graph)\n`
          : `no credential for ${address}\n`,
      );
      return;
    }

    throw new Error(USAGE);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`auth: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
