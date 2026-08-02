/**
 * M11-1 C19 `[integration]` — the AO seed installs a non-authenticating demo credential on a
 * fresh database, and the neutralization migration rewrites literals wherever they already
 * exist. Both are driven through the real runner (records deleted first so it does not skip).
 */
import { join } from "path";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { getAgentFromRequest } from "@/lib/auth";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");

const connectionString = process.env.POSTGRES_URL as string;
const SCRIPTS_DIR = join(__dirname, "../../../scripts");
const SEED_FILE = "migrate-ao-seed-moiraine.sql";
const NEUTRALIZE_FILE = "migrate-neutralize-seeded-credentials.sql";
const OLD_LITERAL = "safemolt_moiraine_stanford_ao_registered";

function runFile(file: string, label: string) {
    return migrate({ files: [{ file, label }], dir: SCRIPTS_DIR, connectionString });
}

function bearer(key: string): Request {
    return new Request("http://localhost/api/v1/agents/me", {
        headers: { authorization: `Bearer ${key}`, "x-school-id": "foundation" },
    });
}

async function deleteMoiraineRows(): Promise<void> {
    await pgPool().query("DELETE FROM agents WHERE LOWER(TRIM(name)) = 'moiraine' OR id LIKE 'c19_%'");
}

afterAll(async () => {
    await deleteMoiraineRows();
    // Leave both files recorded whatever order the tests ran in.
    for (const file of [SEED_FILE, NEUTRALIZE_FILE]) {
        const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [file]);
        if ((rowCount ?? 0) === 0) {
            await runFile(file, `restore ${file}`);
        }
    }
    await closeIntegrationConnections();
});

describe("the seed on a database with no Moiraine", () => {
    it("produces a demo agent whose credential is refused on the prefix — no literal referenced", async () => {
        await deleteMoiraineRows();
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [SEED_FILE]);
        await runFile(SEED_FILE, "C19 seed");

        const { rows } = await pgPool().query<{ api_key: string; is_admitted: boolean; is_vetted: boolean }>(
            "SELECT api_key, is_admitted, is_vetted FROM agents WHERE id = 'agent_moiraine_stanford_ao'"
        );
        expect(rows).toHaveLength(1);
        // Asserted without naming the value: whatever the seed wrote, authentication refuses it.
        expect(await getAgentFromRequest(bearer(rows[0].api_key))).toBeNull();
        // The demo row still serves AO surfaces (admitted + vetted flags are what they render on).
        expect(rows[0].is_admitted).toBe(true);
        expect(rows[0].is_vetted).toBe(true);
    });

    it("the seeded disabled claim token cannot be used to take over the vetted+admitted demo agent (M11-1b review B1)", async () => {
        await deleteMoiraineRows();
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [SEED_FILE]);
        await runFile(SEED_FILE, "C19 seed");

        const { getAgentByClaimToken, claimAgentForHumanUser } = await import("@/lib/store/agents/db");
        const { rows } = await pgPool().query<{ claim_token: string }>(
            "SELECT claim_token FROM agents WHERE id = 'agent_moiraine_stanford_ao'"
        );
        const seededToken = rows[0].claim_token;
        expect(seededToken.startsWith("disabled_")).toBe(true);

        // The claim lookup and the decisive claim both refuse a disabled-prefixed token, so the
        // takeover chain — claim → become owner → POST re-issue → receive a working key against a
        // vetted+admitted row — can never begin.
        expect(await getAgentByClaimToken(seededToken)).toBeNull();
        expect(await claimAgentForHumanUser(seededToken, "attacker-human", "Attacker")).toBeNull();

        const { rows: after } = await pgPool().query<{ is_claimed: boolean }>(
            "SELECT is_claimed FROM agents WHERE id = 'agent_moiraine_stanford_ao'"
        );
        expect(after[0].is_claimed).toBe(false);
    });
});

describe("the neutralization migration on a database carrying the old literal", () => {
    it("leaves zero authenticating rows and is idempotent", async () => {
        await deleteMoiraineRows();
        await pgPool().query(
            `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, claim_token, verification_code, is_vetted, is_admitted)
             VALUES ('c19_legacy', 'c19_legacy', '', $1, 0, 0, false, NOW(), 'claim_moiraine_stanford_ao', 'reef-DEMO', true, true)`,
            [OLD_LITERAL]
        );
        // The literal authenticates before the fix — the characterization half.
        expect((await getAgentFromRequest(bearer(OLD_LITERAL)))?.id).toBe("c19_legacy");

        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [NEUTRALIZE_FILE]);
        await runFile(NEUTRALIZE_FILE, "C19 neutralize");

        // Preflight/postcondition query: zero rows carry any known literal.
        const { rows: remaining } = await pgPool().query(
            `SELECT 1 FROM agents
             WHERE api_key = $1 OR claim_token = 'claim_moiraine_stanford_ao' OR verification_code = 'reef-DEMO'`,
            [OLD_LITERAL]
        );
        expect(remaining).toHaveLength(0);
        expect(await getAgentFromRequest(bearer(OLD_LITERAL))).toBeNull();

        // The rewritten key is disabled-prefixed, so even the rewritten value cannot authenticate.
        const { rows } = await pgPool().query<{ api_key: string }>(
            "SELECT api_key FROM agents WHERE id = 'c19_legacy'"
        );
        expect(rows[0].api_key.startsWith("disabled_")).toBe(true);
        expect(await getAgentFromRequest(bearer(rows[0].api_key))).toBeNull();

        // Idempotent: a second pass through the runner changes nothing.
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [NEUTRALIZE_FILE]);
        await runFile(NEUTRALIZE_FILE, "C19 neutralize again");
        const { rows: after } = await pgPool().query("SELECT api_key FROM agents WHERE id = 'c19_legacy'");
        expect(after[0].api_key).toBe(rows[0].api_key);
    });
});
