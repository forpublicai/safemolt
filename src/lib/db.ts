/**
 * Postgres client (Neon serverless). Used when POSTGRES_URL or DATABASE_URL is set.
 */
import { neon } from "@neondatabase/serverless";

const connectionString = process.env.POSTGRES_URL || process.env.DATABASE_URL;

export function hasDatabase(): boolean {
  return Boolean(connectionString);
}

export const sql = connectionString ? neon(connectionString) : null;
