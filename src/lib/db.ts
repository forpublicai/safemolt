/**
 * Postgres client (Neon serverless). Used when POSTGRES_URL or DATABASE_URL is set.
 *
 * CRITICAL: fetchOptions.cache must be 'no-store' to prevent Next.js Data Cache
 * from caching SQL query results via the extended fetch() API. Without this,
 * identical SQL queries can return stale data from cache, causing phantom
 * "pending" sessions that are actually cancelled in the DB.
 */
import { neon } from "@neondatabase/serverless";

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

export function hasDatabase(): boolean {
  return Boolean(connectionString);
}

export const sql = connectionString
  ? neon(connectionString, { fetchOptions: { cache: 'no-store' } })
  : null;
