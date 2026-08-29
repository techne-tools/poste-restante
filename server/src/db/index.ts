/**
 * Postgres client. The archive spine.
 */
import pg from "pg";
import { migrate } from "./migrate.js";

export interface Db {
  pool: pg.Pool;
  close(): Promise<void>;
}

export async function connectDb(databaseUrl: string): Promise<Db> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  // Fail fast if the database is unreachable.
  await pool.query("SELECT 1");
  return {
    pool,
    async close() {
      await pool.end();
    },
  };
}

/** Connect and apply migrations. */
export async function connectDbAndMigrate(databaseUrl: string): Promise<Db> {
  const db = await connectDb(databaseUrl);
  await migrate(db.pool);
  return db;
}
