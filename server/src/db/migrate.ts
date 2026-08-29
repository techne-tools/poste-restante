/**
 * Migration runner. Applies `src/db/migrations/*.sql` in filename order,
 * tracking applied migrations in a `schema_migrations` table.
 *
 * Portable plain SQL — no version-specific features beyond postgres 15.
 */
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "migrations");

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

export async function migrate(
  pool: pg.Pool,
  migrationsDir: string = MIGRATIONS_DIR,
): Promise<MigrationResult> {
  const client = await pool.connect();
  const applied: string[] = [];
  const skipped: string[] = [];
  try {
    await client.query("BEGIN");
    await client.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         name text PRIMARY KEY,
         applied_at timestamptz NOT NULL DEFAULT now()
       )`,
    );

    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith(".sql"))
      .sort();

    const { rows } = await client.query<{ name: string }>(
      "SELECT name FROM schema_migrations",
    );
    const done = new Set(rows.map((r) => r.name));

    for (const file of files) {
      if (done.has(file)) {
        skipped.push(file);
        continue;
      }
      const sql = await readFile(join(migrationsDir, file), "utf8");
      await client.query(sql);
      await client.query("INSERT INTO schema_migrations (name) VALUES ($1)", [file]);
      applied.push(file);
    }

    await client.query("COMMIT");
    return { applied, skipped };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

/**
 * CLI entrypoint: `npm run migrate` (or `tsx src/db/migrate.ts`). Reads
 * DATABASE_URL from the environment and applies pending migrations.
 */
async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required to run migrations");
  }
  const pool = new pg.Pool({ connectionString: databaseUrl });
  try {
    const result = await migrate(pool);
    for (const name of result.applied) process.stdout.write(`applied ${name}\n`);
    for (const name of result.skipped) process.stdout.write(`skipped ${name}\n`);
    process.stdout.write(
      `migrations complete: ${result.applied.length} applied, ${result.skipped.length} skipped\n`,
    );
  } finally {
    await pool.end();
  }
}

// Run only when executed directly (not when imported).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    process.stderr.write(`migration failed: ${String(err)}\n`);
    process.exit(1);
  });
}
