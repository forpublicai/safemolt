/**
 * M11-1 C24 `[integration]` — the published bearer must stop authenticating, asserted by trying it.
 *
 * The unit tests around this chunk read source text and migration contents. That proves the literal
 * is gone from the tree; it says nothing about whether the value still opens the door. This seeds a
 * professor carrying the exact published literal, runs the rotation migration through the **real**
 * runner, and then attempts authentication with it.
 */
import { pgPool, closeIntegrationConnections } from "./helpers/db";
import { getProfessorByApiKey } from "@/lib/store/classes/db";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");

const PUBLISHED_LITERAL = "foundation-api-key";
const PROBE_ID = "c24_probe_prof";
const MIGRATION = {
    file: "migrate-rotate-published-professor-keys.sql",
    label: "Rotate published professor API keys",
};

const connectionString = process.env.POSTGRES_URL as string;
const migrationsDir = require("path").join(__dirname, "..", "..", "..", "scripts");

async function seedLiteralProfessor(): Promise<void> {
    await pgPool().query("DELETE FROM professors WHERE id = $1", [PROBE_ID]);
    await pgPool().query(
        "INSERT INTO professors (id, name, email, api_key, created_at) VALUES ($1, $2, $3, $4, NOW())",
        [PROBE_ID, "C24 probe", "c24@example.com", PUBLISHED_LITERAL]
    );
}

/** The migration is already recorded from setup; re-running it needs the record cleared. */
async function runRotation(): Promise<void> {
    await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION.file]);
    await migrate({ files: [MIGRATION], dir: migrationsDir, connectionString });
}

afterAll(async () => {
    await pgPool().query("DELETE FROM professors WHERE id = $1", [PROBE_ID]);
    await closeIntegrationConnections();
});

describe("the published professor bearer", () => {
    it("authenticates before rotation — the exploit, characterised", async () => {
        await seedLiteralProfessor();
        const professor = await getProfessorByApiKey(PUBLISHED_LITERAL);
        expect(professor?.id).toBe(PROBE_ID);
    });

    it("does not authenticate after the rotation migration runs", async () => {
        await seedLiteralProfessor();
        await runRotation();

        expect(await getProfessorByApiKey(PUBLISHED_LITERAL)).toBeNull();
    });

    it("replaces it with a CSPRNG value that is not reproducible from source", async () => {
        await seedLiteralProfessor();
        await runRotation();

        const { rows } = await pgPool().query<{ api_key: string }>(
            "SELECT api_key FROM professors WHERE id = $1",
            [PROBE_ID]
        );
        expect(rows[0].api_key).toMatch(/^prof_[0-9a-f]{64}$/);
        expect(rows[0].api_key).not.toContain(PUBLISHED_LITERAL);
    });

    it("is idempotent — a second run rotates nothing further", async () => {
        await seedLiteralProfessor();
        await runRotation();
        const { rows: first } = await pgPool().query<{ api_key: string }>(
            "SELECT api_key FROM professors WHERE id = $1",
            [PROBE_ID]
        );

        await runRotation();
        const { rows: second } = await pgPool().query<{ api_key: string }>(
            "SELECT api_key FROM professors WHERE id = $1",
            [PROBE_ID]
        );
        expect(second[0].api_key).toBe(first[0].api_key);
    });
});
