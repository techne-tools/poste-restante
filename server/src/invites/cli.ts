/**
 * Poste Restante — the invite CLI (SPEC §5.7).
 *
 *   npm run invite:new -- <owner> <guest>   # mint an invite; prints the code once
 *
 * The owner vouches for a guest: the house writes the invite letter (the
 * dormant address + voucher edge enter the social graph) and stores only the
 * code hash. The code is given to the guest out of band — the house never
 * pushes. The guest redeems via `POST /v1/invites/redeem` with the letter's
 * address, the code, and a password they set themselves.
 */
import { connectDbAndMigrate } from "../db/index.js";
import { loadConfig } from "../config.js";
import { createLogger } from "../pipeline/logger.js";
import { IngestionPipeline } from "../pipeline/pipeline.js";
import { PostgresRepository } from "../db/repository.js";
import { createEmbedder } from "../embed/embedder.js";
import { QdrantSemanticStore } from "../qdrant/store.js";
import { NoopPayloadStore } from "../minio/store.js";
import { AuthService } from "../auth/service.js";
import { InviteService } from "./service.js";

const USAGE = `usage:
  npm run invite:new -- <owner> <guest>   mint an invite; prints the code once`;

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0];

  const config = loadConfig(process.env);
  const db = await connectDbAndMigrate(config.databaseUrl);
  const repo = new PostgresRepository(db.pool);
  const embedder = createEmbedder(config.embedding);
  const semantic = new QdrantSemanticStore(
    config.qdrantUrl,
    config.qdrantCollection,
    embedder,
  );
  await semantic.ensureCollection();
  const log = createLogger();
  const pipeline = new IngestionPipeline(
    repo,
    semantic,
    embedder,
    new NoopPayloadStore(),
    log,
  );
  const auth = new AuthService(db.pool, log, config.auth);
  const invites = new InviteService(db.pool, pipeline, auth);

  try {
    if (command === "new") {
      const owner = args[1];
      const guest = args[2];
      if (!owner || !guest) throw new Error(USAGE);
      const minted = await invites.mint(owner, guest);
      process.stdout.write(`invite written to ${guest} by ${owner}\n`);
      process.stdout.write(`letter id: ${minted.letterId}\n`);
      process.stdout.write(`\n  ${minted.code}\n\n`);
      process.stdout.write(
        `tell ${guest} out of band — the house never pushes. ` +
          `the code is shown once; it is stored only as a hash.\n`,
      );
      return;
    }

    throw new Error(USAGE);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  process.stderr.write(`invite: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
