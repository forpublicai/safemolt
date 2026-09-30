/**
 * M11-1 C1 `[integration]` — the migration runner fails loudly and never records on error.
 *
 * Driven through the *real* `scripts/migrate.js` over fixture files, because the defect being
 * closed is in the runner itself: an object-exists error used to record the file as applied even
 * though a migration file runs as one implicit transaction, so a collision halfway through rolled
 * back every earlier statement and prevented every later one.
 */
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { pgPool, closeIntegrationConnections } from "./helpers/db";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");

const connectionString = process.env.POSTGRES_URL as string;

let fixtureDir: string;

/** Fixture object names, namespaced so they cannot collide with application schema. */
const FIRST = "_c1_fixture_first";
const SECOND = "_c1_fixture_second";
const DATA = "_c1_fixture_data";

function writeFixture(name: string, sql: string) {
    writeFileSync(join(fixtureDir, name), sql);
}

async function recordedFilenames(): Promise<string[]> {
    const { rows } = await pgPool().query<{ filename: string }>(
        "SELECT filename FROM _migrations WHERE filename LIKE '_c1_%' ORDER BY filename"
    );
    return rows.map((r) => r.filename);
}

/**
 * An explicit schema postcondition, deliberately independent of the runner's skip path.
 *
 * Re-running the runner proves nothing about a partially-applied file: recorded filenames are
 * skipped *before* their SQL is ever examined. Detecting "recorded yet absent" therefore requires
 * asking the catalog directly, which is what this does.
 */
async function objectExists(name: string): Promise<boolean> {
    const { rows } = await pgPool().query<{ present: boolean }>(
        "SELECT to_regclass($1) IS NOT NULL AS present",
        [`public.${name}`]
    );
    return rows[0].present;
}

beforeAll(() => {
    fixtureDir = mkdtempSync(join(tmpdir(), "c1-migrations-"));
});

beforeEach(async () => {
    await pgPool().query("DELETE FROM _migrations WHERE filename LIKE '_c1_%'");
    for (const name of [FIRST, SECOND, DATA]) {
        await pgPool().query(`DROP TABLE IF EXISTS ${name} CASCADE`);
    }
});

afterAll(async () => {
    for (const name of [FIRST, SECOND, DATA]) {
        await pgPool().query(`DROP TABLE IF EXISTS ${name} CASCADE`);
    }
    await pgPool().query("DELETE FROM _migrations WHERE filename LIKE '_c1_%'");
    rmSync(fixtureDir, { recursive: true, force: true });
    await closeIntegrationConnections();
});

describe("a file whose first object exists and whose second is absent", () => {
    const FILE = "_c1_partial.sql";

    beforeEach(async () => {
        // The collision the file will hit, pre-existing.
        await pgPool().query(`CREATE TABLE ${FIRST} (id text PRIMARY KEY)`);
        writeFixture(
            FILE,
            `CREATE TABLE ${FIRST} (id text PRIMARY KEY);\nCREATE TABLE ${SECOND} (id text PRIMARY KEY);\n`
        );
    });

    it("fails, records nothing, and leaves the later object absent", async () => {
        await expect(
            migrate({ files: [{ file: FILE, label: "C1 partial fixture" }], dir: fixtureDir, connectionString })
        ).rejects.toMatchObject({ code: "42P07" });

        expect(await recordedFilenames()).toEqual([]);
        // The rollback is the whole point: the second object never appeared.
        expect(await objectExists(SECOND)).toBe(false);
    });

    it("applies and records once the file is rewritten idempotently", async () => {
        await expect(
            migrate({ files: [{ file: FILE, label: "C1 partial fixture" }], dir: fixtureDir, connectionString })
        ).rejects.toBeTruthy();

        writeFixture(
            FILE,
            `CREATE TABLE IF NOT EXISTS ${FIRST} (id text PRIMARY KEY);\n` +
                `CREATE TABLE IF NOT EXISTS ${SECOND} (id text PRIMARY KEY);\n`
        );

        await migrate({ files: [{ file: FILE, label: "C1 partial fixture" }], dir: fixtureDir, connectionString });

        expect(await recordedFilenames()).toEqual([FILE]);
        expect(await objectExists(SECOND)).toBe(true);
    });
});

describe("a recorded-but-partial file", () => {
    const FILE = "_c1_seeded_partial.sql";

    it("is skipped without its SQL being read, so only a schema postcondition can detect it", async () => {
        // Seed the exact state the old runner produced: recorded, but its objects never applied.
        await pgPool().query("INSERT INTO _migrations (filename, label) VALUES ($1, $2)", [
            FILE,
            "C1 seeded partial",
        ]);
        writeFixture(FILE, `CREATE TABLE ${FIRST} (id text PRIMARY KEY);\nCREATE TABLE ${SECOND} (id text PRIMARY KEY);\n`);

        await migrate({ files: [{ file: FILE, label: "C1 seeded partial" }], dir: fixtureDir, connectionString });

        // A re-run is a green no-op — this is why "just re-run it" is not a diagnosis.
        expect(await recordedFilenames()).toEqual([FILE]);
        // The independent postcondition is what actually catches it.
        expect(await objectExists(FIRST)).toBe(false);
        expect(await objectExists(SECOND)).toBe(false);
    });
});

describe("listed files that cannot be applied", () => {
    it("fails when the file is missing", async () => {
        await expect(
            migrate({
                files: [{ file: "_c1_absent.sql", label: "C1 missing fixture" }],
                dir: fixtureDir,
                connectionString,
            })
        ).rejects.toThrow(/is missing/);
        expect(await recordedFilenames()).toEqual([]);
    });

    it("fails when the file is empty", async () => {
        writeFixture("_c1_empty.sql", "   \n\n  ");
        await expect(
            migrate({
                files: [{ file: "_c1_empty.sql", label: "C1 empty fixture" }],
                dir: fixtureDir,
                connectionString,
            })
        ).rejects.toThrow(/is empty/);
        expect(await recordedFilenames()).toEqual([]);
    });
});

describe("a recorded file that later disappears", () => {
    it("is still fatal — migrations are append-only and a fresh database needs the file", async () => {
        // The artifact check runs *before* the `_migrations` lookup, deliberately.
        //
        // An earlier version of this suite codified the opposite, arguing that a recorded file has
        // already applied so losing it is housekeeping. That is true only of the database in front
        // of you: a deployment whose schema is current would go green while the repository had
        // silently lost a migration every *new* environment still depends on.
        const FILE = "_c1_recorded_then_deleted.sql";
        await pgPool().query("INSERT INTO _migrations (filename, label) VALUES ($1, $2)", [
            FILE,
            "C1 recorded then deleted",
        ]);

        await expect(
            migrate({
                files: [{ file: FILE, label: "C1 recorded then deleted" }],
                dir: fixtureDir,
                connectionString,
            })
        ).rejects.toThrow(/is missing/);
    });

    it("is fatal when the file is emptied rather than deleted", async () => {
        const FILE = "_c1_recorded_then_emptied.sql";
        writeFixture(FILE, "\n\n");
        await pgPool().query("INSERT INTO _migrations (filename, label) VALUES ($1, $2)", [
            FILE,
            "C1 recorded then emptied",
        ]);

        await expect(
            migrate({
                files: [{ file: FILE, label: "C1 recorded then emptied" }],
                dir: fixtureDir,
                connectionString,
            })
        ).rejects.toThrow(/is empty/);
    });
});

describe("data-level errors", () => {
    const FILE = "_c1_unique_violation.sql";

    it("never swallows a 23505 and never records the file", async () => {
        // The old runner matched the bare substring "duplicate", which caught this too.
        writeFixture(
            FILE,
            `CREATE TABLE IF NOT EXISTS ${DATA} (id text PRIMARY KEY);\n` +
                `INSERT INTO ${DATA} (id) VALUES ('x');\n` +
                `INSERT INTO ${DATA} (id) VALUES ('x');\n`
        );

        await expect(
            migrate({ files: [{ file: FILE, label: "C1 unique violation" }], dir: fixtureDir, connectionString })
        ).rejects.toMatchObject({ code: "23505" });

        expect(await recordedFilenames()).toEqual([]);
        expect(await objectExists(DATA)).toBe(false);
    });
});

describe("the happy path still works", () => {
    it("applies a clean file and records it exactly once", async () => {
        const FILE = "_c1_clean.sql";
        writeFixture(FILE, `CREATE TABLE IF NOT EXISTS ${FIRST} (id text PRIMARY KEY);\n`);

        await migrate({ files: [{ file: FILE, label: "C1 clean" }], dir: fixtureDir, connectionString });
        await migrate({ files: [{ file: FILE, label: "C1 clean" }], dir: fixtureDir, connectionString });

        expect(await recordedFilenames()).toEqual([FILE]);
        expect(await objectExists(FIRST)).toBe(true);
    });
});
