/**
 * M11-1 C0 — connections for the integration harness.
 *
 * Both drivers are exposed deliberately. The plan's atomicity claims are driver-specific:
 * auto-commit per call, batch elements not reading one another's RETURNING, CTE snapshot rules,
 * and the fact that a standalone `SELECT ... FOR UPDATE` over Neon HTTP has already released its
 * lock by the time a JavaScript barrier is reached. Asserting those on `pg` alone would prove
 * nothing about production, which runs the Neon HTTP driver.
 */
import { Client, Pool } from "pg";
import { neon, type NeonQueryFunction } from "@neondatabase/serverless";

function connectionString(): string {
    const url = process.env.POSTGRES_URL;
    if (!url) throw new Error("[integration] POSTGRES_URL is unset");
    return url;
}

function reservedDatabase(): string {
    const reserved = process.env.INTEGRATION_RESERVED_DATABASE;
    if (!reserved) throw new Error("[integration] INTEGRATION_RESERVED_DATABASE is unset");
    return reserved;
}

let pool: Pool | null = null;

/** Shared `pg` pool — the driver the migration runner uses. */
export function pgPool(): Pool {
    if (!pool) pool = new Pool({ connectionString: connectionString(), max: 8 });
    return pool;
}

/** A dedicated `pg` connection, for work that must own a session (transactions, locks). */
export async function pgClient(): Promise<Client> {
    const client = new Client({ connectionString: connectionString() });
    await client.connect();
    return client;
}

/** The Neon HTTP driver — the driver the application actually runs. */
export function neonSql(): NeonQueryFunction<false, false> {
    return neon(connectionString(), { fetchOptions: { cache: "no-store" } });
}

export async function closeIntegrationConnections(): Promise<void> {
    if (pool) {
        await pool.end();
        pool = null;
    }
}

const OWNER_MARKER_TABLE = "_harness_owner";
const OWNER_MARKER_VALUE = "safemolt-m11-integration-harness";

/**
 * Truncate every application table.
 *
 * `_migrations` and the ownership marker are preserved so the schema is not re-applied and the
 * database does not stop being recognisably the harness's.
 *
 * Two checks, not one, and the second is the load-bearing one: matching the database *name* proves
 * only that something is called `safemolt_integration`, which a pre-existing database could also
 * be. The ownership marker `prepare` stamps into the database it created is what distinguishes the
 * harness's own artefact from somebody else's data. Both are re-asserted here, at the destructive
 * call, because a guard that only ran at process start would not protect a helper imported from
 * somewhere unexpected.
 */
export async function truncateAllTables(options: { except?: string[] } = {}): Promise<void> {
    const preserved = new Set(["_migrations", OWNER_MARKER_TABLE, ...(options.except ?? [])]);
    const client = await pgClient();
    try {
        const { rows: dbRows } = await client.query<{ db: string }>("SELECT current_database() AS db");
        if (dbRows[0].db !== reservedDatabase()) {
            throw new Error(
                `[integration] truncate refused: connected to '${dbRows[0].db}', expected '${reservedDatabase()}'`
            );
        }

        const { rows: owner } = await client.query<{ owner: string }>(
            `SELECT owner FROM ${OWNER_MARKER_TABLE} LIMIT 1`
        );
        if (owner[0]?.owner !== OWNER_MARKER_VALUE) {
            throw new Error(
                `[integration] truncate refused: '${dbRows[0].db}' carries no harness ownership marker`
            );
        }

        const { rows } = await client.query<{ tablename: string }>(
            "SELECT tablename FROM pg_tables WHERE schemaname = 'public'"
        );
        const targets = rows.map((r) => r.tablename).filter((name) => !preserved.has(name));
        if (targets.length === 0) return;

        const quoted = targets.map((name) => `"${name.replace(/"/g, '""')}"`).join(", ");
        await client.query(`TRUNCATE TABLE ${quoted} RESTART IDENTITY CASCADE`);
    } finally {
        await client.end();
    }
}
