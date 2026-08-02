/**
 * M11-1 C5 `[integration]` — case-insensitive agent-name uniqueness.
 *
 * Entirely DB-dependent: the defect is that `agents.name`'s uniqueness was case-sensitive while
 * `getAgentByName` resolves case-folded, so `Foo` and `foo` could coexist and one resolved
 * arbitrarily. The migration is driven through the *real* `scripts/migrate.js` (its `_migrations`
 * record is deleted first so the runner does not skip it), and the SHARE-lock claim is observed
 * via `pg_blocking_pids`, not wall-clock ordering.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { closeIntegrationConnections, neonSql, pgPool } from "./helpers/db";
import { raceAgainstHeldLock } from "./helpers/concurrency";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");

const connectionString = process.env.POSTGRES_URL as string;
const SCRIPTS_DIR = join(__dirname, "../../../scripts");
const MIGRATION_FILE = "migrate-agent-name-ci-unique.sql";
const INDEX_NAME = "idx_agents_name_lower";
const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;

function runMigration() {
    return migrate({
        files: [{ file: MIGRATION_FILE, label: "C5 unique lower name" }],
        dir: SCRIPTS_DIR,
        connectionString,
    });
}

async function indexShape(): Promise<{ unique: boolean; expr: string | null } | null> {
    const { rows } = await pgPool().query<{ unique: boolean; expr: string | null }>(
        `SELECT i.indisunique AS "unique", pg_get_expr(i.indexprs, i.indrelid) AS expr
         FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = $1 AND i.indrelid = 'public.agents'::regclass`,
        [INDEX_NAME]
    );
    return rows[0] ?? null;
}

async function migrationRecorded(): Promise<boolean> {
    const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
    return (rowCount ?? 0) > 0;
}

async function seedAgent(id: string, name: string): Promise<void> {
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at)
         VALUES ($1, $2, '', $3, 0, 0, false, NOW())`,
        [id, name, `c5_key_${id}`]
    );
}

async function cleanUp(): Promise<void> {
    await pgPool().query("DELETE FROM agents WHERE id LIKE 'c5_%' OR name LIKE 'c5_%' OR name LIKE 'C5_%'");
}

afterAll(async () => {
    await cleanUp();
    // Leave the database in the applied state whatever order the tests ran in.
    if (!(await migrationRecorded())) await runMigration();
    await closeIntegrationConnections();
});

describe("the migration through the real runner", () => {
    it("collision fixture ⇒ loud P0001, nothing recorded, data untouched; clean data ⇒ unique index", async () => {
        // Reconstruct the pre-migration state: plain index, colliding rows.
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await pgPool().query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
        await pgPool().query(`CREATE INDEX ${INDEX_NAME} ON agents (LOWER(name))`);
        await seedAgent(`c5_coll_a_${RUN}`, `C5_Collide_${RUN}`);
        await seedAgent(`c5_coll_b_${RUN}`, `c5_collide_${RUN}`);

        await expect(runMigration()).rejects.toMatchObject({ code: "P0001" });
        expect(await migrationRecorded()).toBe(false);
        // The rollback left the plain index and both rows in place.
        expect((await indexShape())?.unique).toBe(false);
        const { rows } = await pgPool().query("SELECT id FROM agents WHERE LOWER(name) = LOWER($1)", [
            `c5_collide_${RUN}`,
        ]);
        expect(rows).toHaveLength(2);

        // Resolve the collision (release one), re-run — the recovery path the file documents.
        await pgPool().query("DELETE FROM agents WHERE id = $1", [`c5_coll_b_${RUN}`]);
        await runMigration();
        expect(await migrationRecorded()).toBe(true);
        const shape = await indexShape();
        expect(shape).toEqual({ unique: true, expr: "lower(name)" });
    });
});

describe("registration against the unique index", () => {
    const savedEnv: Record<string, string | undefined> = {};

    beforeAll(() => {
        for (const k of ["TRUSTED_PROXY_MODE", "TRUSTED_PROXY_HOPS"]) savedEnv[k] = process.env[k];
        // Per-run x-real-ip buckets so re-runs inside one window cannot exhaust the shared
        // unknown bucket and flake the suite.
        process.env.TRUSTED_PROXY_MODE = "managed-edge";
    });

    afterAll(() => {
        for (const [k, v] of Object.entries(savedEnv)) {
            if (v === undefined) delete process.env[k];
            else process.env[k] = v;
        }
    });

    function registerRequest(name: string): Request {
        return new Request("http://localhost/api/v1/agents/register", {
            method: "POST",
            headers: { "content-type": "application/json", "x-real-ip": `c5-${RUN}` },
            body: JSON.stringify({ name }),
        });
    }

    it("rejects a case-fold duplicate with the same friendly error as an exact duplicate", async () => {
        const { POST } = await import("@/app/api/v1/agents/register/route");
        const name = `C5_Route_${RUN}`;

        const first = await POST(registerRequest(name));
        expect(first.status).toBe(200);

        const exact = await POST(registerRequest(name));
        expect(exact.status).toBe(400);
        const exactBody = await exact.json();

        const folded = await POST(registerRequest(name.toLowerCase()));
        expect(folded.status).toBe(400);
        const foldedBody = await folded.json();

        expect(exactBody.error).toContain("already exists");
        expect(foldedBody.error).toBe(exactBody.error);
    });
});

describe("the SHARE lock the migration holds", () => {
    // The race test below installs its OWN lock, so removing the migration's lock would leave it
    // green (M11-1b review B9). This asserts the file still opens with the lock — the regression
    // guard the race test cannot be.
    it("the migration file acquires the SHARE lock before it reads or builds anything", () => {
        const source = readFileSync(join(SCRIPTS_DIR, MIGRATION_FILE), "utf8");
        expect(source).toMatch(/LOCK TABLE agents IN SHARE MODE/);
        const lockAt = source.indexOf("LOCK TABLE agents IN SHARE MODE");
        const collisionCheckAt = source.indexOf("case-fold name collision");
        const indexBuildAt = source.indexOf("CREATE UNIQUE INDEX");
        // The lock precedes both the collision preflight and the index build.
        expect(lockAt).toBeGreaterThanOrEqual(0);
        expect(lockAt).toBeLessThan(collisionCheckAt);
        expect(lockAt).toBeLessThan(indexBuildAt);
    });

    it("a concurrent registration insert blocks until the lock releases, then lands", async () => {
        const name = `C5_Blocked_${RUN}`;
        const outcome = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query("LOCK TABLE agents IN SHARE MODE");
            },
            // A real async wrapper, not the bare Neon tagged call: NeonQueryPromise is lazy and
            // re-executes on every await, and the race helper awaits its contender twice.
            contend: async () =>
                await neonSql()`
                    INSERT INTO agents /* race:c5-share-lock */ (id, name, description, api_key, points, follower_count, is_claimed, created_at)
                    VALUES (${`c5_race_${RUN}`}, ${name}, '', ${`c5_race_key_${RUN}`}, 0, 0, false, NOW())
                    RETURNING id
                `,
            contenderMarker: "race:c5-share-lock",
        });
        expect(outcome.observedBlocked).toBe(true);
        // The insert landed after the lock released — and only once, under the unique index.
        const { rows } = await pgPool().query("SELECT id FROM agents WHERE LOWER(name) = LOWER($1)", [name]);
        expect(rows).toHaveLength(1);
    });
});
