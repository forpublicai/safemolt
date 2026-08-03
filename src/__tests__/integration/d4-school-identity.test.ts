/**
 * M11-1b D4 part 4, DEPLOY 1 (expand) `[integration]` — school becomes part of an evaluation's
 * identity, starting with the definition row.
 *
 * What this deploy can and cannot prove is stated in the migration's own header and repeated here
 * so a reader does not mistake a passing suite for a closed defect: `evaluation_definitions.id` is
 * still `TEXT PRIMARY KEY` after this migration, so two schools STILL cannot both hold
 * `twitter-verification`. That coexistence is deploy 3's, after old instances drain. This deploy
 * builds the composite key and — the part the plan did not name — moves `sip_number` uniqueness
 * into the school, without which deploy 3 could not succeed at all.
 */
import { join } from "path";
import { closeIntegrationConnections, pgPool } from "./helpers/db";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");
const SCRIPTS_DIR = join(__dirname, "../../../scripts");
const MIGRATION_FILE = "migrate-evaluation-definitions-school-identity.sql";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

async function seedDefinition(fields: { id: string; school: string; sip: number }): Promise<void> {
    await pgPool().query(
        `INSERT INTO evaluation_definitions
           (id, sip_number, name, module, type, status, file_path, executable_handler,
            executable_script_path, version, created_at, updated_at, school_id)
         VALUES ($1, $2, $1, 'core', 'simple_pass_fail', 'active', 'x', 'x', 'x', '1.0.0', NOW(), NOW(), $3)`,
        [fields.id, fields.sip, fields.school]
    );
}

function runMigration() {
    return migrate({
        files: [{ file: MIGRATION_FILE, label: "D4 school identity (expand)" }],
        dir: SCRIPTS_DIR,
        connectionString: process.env.POSTGRES_URL,
    });
}

async function migrationRecorded(): Promise<boolean> {
    const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
    return (rowCount ?? 0) > 0;
}

async function indexShape(name: string) {
    const { rows } = await pgPool().query(
        `SELECT i.indisunique,
                (SELECT array_agg(attname::text ORDER BY attname) FROM pg_attribute
                  WHERE attrelid = t.oid AND attnum = ANY (i.indkey)) AS cols
         FROM pg_index i
         JOIN pg_class c ON c.oid = i.indexrelid
         JOIN pg_class t ON t.oid = i.indrelid
         WHERE c.relname = $1 AND t.relname = 'evaluation_definitions'`,
        [name]
    );
    return rows[0] ?? null;
}

afterAll(async () => {
    await pgPool().query("DELETE FROM evaluation_definitions WHERE id LIKE $1", [`d4_def_${RUN}%`]);
    if (!(await migrationRecorded())) await runMigration();
    await closeIntegrationConnections();
});

describe("the expand migration through the real runner", () => {
    it("applies clean, records, and builds both composite uniques", async () => {
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await runMigration();
        expect(await migrationRecorded()).toBe(true);

        expect(await indexShape("idx_eval_def_school_id")).toMatchObject({
            indisunique: true,
            cols: ["id", "school_id"],
        });
        expect(await indexShape("idx_eval_def_school_sip")).toMatchObject({
            indisunique: true,
            cols: ["school_id", "sip_number"],
        });
    });

    it("re-running changes nothing", async () => {
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await runMigration();
        expect(await migrationRecorded()).toBe(true);
        expect(await indexShape("idx_eval_def_school_id")).toMatchObject({ indisunique: true });
    });

    it("leaves school_id NOT NULL, so the composite key can never be built over NULLs", async () => {
        const { rows } = await pgPool().query(
            `SELECT is_nullable, column_default FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'evaluation_definitions' AND column_name = 'school_id'`
        );
        expect(rows[0].is_nullable).toBe("NO");
        expect(String(rows[0].column_default)).toContain("foundation");
    });

    it("REMOVES the global sip_number uniqueness — two schools must be able to ship SIP 4", async () => {
        // The plan did not name this constraint. Foundation and Humanities both ship `sip: 4`
        // (schools/foundation/evaluations/SIP-4.md, schools/humanities/evaluations/SIP-4.md), so
        // while `sip_number INTEGER UNIQUE` stands, deploy 3 cannot succeed no matter what happens
        // to the primary key: the second school's row would be rejected with 23505.
        const { rows } = await pgPool().query(
            `SELECT 1 FROM pg_constraint c
             JOIN pg_class t ON t.oid = c.conrelid
             WHERE t.relname = 'evaluation_definitions' AND c.contype = 'u'
               AND array_length(c.conkey, 1) = 1
               AND c.conkey[1] = (SELECT attnum FROM pg_attribute WHERE attrelid = t.oid AND attname = 'sip_number')`
        );
        expect(rows).toHaveLength(0);

        // Proof rather than inference: the same SIP number in two different schools now coexists.
        const sip = 9700 + (seq += 1);
        await seedDefinition({ id: `d4_def_${RUN}_a`, school: `d4_school_${RUN}_a`, sip });
        await seedDefinition({ id: `d4_def_${RUN}_b`, school: `d4_school_${RUN}_b`, sip });
        const { rows: both } = await pgPool().query(
            "SELECT id FROM evaluation_definitions WHERE sip_number = $1 ORDER BY id",
            [sip]
        );
        expect(both.map((r) => r.id)).toEqual([`d4_def_${RUN}_a`, `d4_def_${RUN}_b`]);
    });

    it("still keeps one SIP number per school", async () => {
        const school = `d4_school_${RUN}_dup`;
        const sip = 9800 + (seq += 1);
        await seedDefinition({ id: `d4_def_${RUN}_s1`, school, sip });
        await expect(seedDefinition({ id: `d4_def_${RUN}_s2`, school, sip })).rejects.toMatchObject({ code: "23505" });
    });

    it("DOES NOT yet allow one id in two schools — that is deploy 3, and this pins the boundary", async () => {
        // Recorded so a reader does not mistake this suite for the closed defect. `id` is still the
        // primary key; the composite unique sits alongside it until old instances have drained.
        await seedDefinition({ id: `d4_def_${RUN}_shared`, school: `d4_school_${RUN}_x`, sip: 9900 + (seq += 1) });
        await expect(
            seedDefinition({ id: `d4_def_${RUN}_shared`, school: `d4_school_${RUN}_y`, sip: 9900 + (seq += 1) })
        ).rejects.toMatchObject({ code: "23505" });
    });
});
