/**
 * M11-1 C17 (re-issue half) `[integration]` — the db-side key rotation and the stale
 * claim-token rotation migration, through the real runner.
 */
import { join } from "path";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { rotateAgentApiKey } from "@/lib/store/agents/db";
import { getAgentFromRequest } from "@/lib/auth";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");

const connectionString = process.env.POSTGRES_URL as string;
const SCRIPTS_DIR = join(__dirname, "../../../scripts");
const MIGRATION_FILE = "migrate-rotate-stale-claim-tokens.sql";
const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

interface SeedOptions {
    claimed?: boolean;
    createdDaysAgo?: number;
    claimToken?: string | null;
}

async function seedAgent(options: SeedOptions = {}): Promise<{ id: string; apiKey: string; claimToken: string | null }> {
    const id = `c17_agent_${RUN}_${(seq += 1)}`;
    const apiKey = `c17_key_${RUN}_${seq}`;
    const claimToken = options.claimToken === null ? null : options.claimToken ?? `claim_leg_${RUN}_${seq}`;
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, claim_token, is_vetted)
         VALUES ($1, $1, '', $2, 0, 0, $3, NOW() - make_interval(days => $4), $5, true)`,
        [id, apiKey, options.claimed ?? false, options.createdDaysAgo ?? 0, claimToken]
    );
    return { id, apiKey, claimToken };
}

async function claimTokenOf(id: string): Promise<string | null> {
    const { rows } = await pgPool().query<{ claim_token: string | null }>(
        "SELECT claim_token FROM agents WHERE id = $1",
        [id]
    );
    return rows[0]?.claim_token ?? null;
}

function bearer(key: string): Request {
    return new Request("http://localhost/api/v1/agents/me", {
        headers: { authorization: `Bearer ${key}`, "x-school-id": "foundation" },
    });
}

function runMigration() {
    return migrate({
        files: [{ file: MIGRATION_FILE, label: "C17 stale claim tokens" }],
        dir: SCRIPTS_DIR,
        connectionString,
    });
}

afterAll(async () => {
    await pgPool().query("DELETE FROM agents WHERE id LIKE $1", [`c17_agent_${RUN}%`]);
    await pgPool().query("DELETE FROM human_users WHERE id LIKE $1", [`c17_user_${RUN}%`]);
    const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
    if ((rowCount ?? 0) === 0) await runMigration();
    await closeIntegrationConnections();
});

const OWNER_USER = `c17_user_${RUN}`;

async function linkOwner(agentId: string, userId = OWNER_USER): Promise<void> {
    await pgPool().query(
        `INSERT INTO human_users (id, cognito_sub, email, created_at) VALUES ($1, $1, $2, NOW())
         ON CONFLICT (id) DO NOTHING`,
        [userId, `${userId}@example.com`]
    );
    await pgPool().query(
        `INSERT INTO user_agents (user_id, agent_id, role) VALUES ($1, $2, 'owner')
         ON CONFLICT (user_id, agent_id) DO UPDATE SET role = 'owner'`,
        [userId, agentId]
    );
}

describe("api-key re-issue (db)", () => {
    it("the old key stops authenticating the moment the rotation commits; the new one works", async () => {
        const agent = await seedAgent();
        await linkOwner(agent.id);
        expect((await getAgentFromRequest(bearer(agent.apiKey)))?.id).toBe(agent.id);

        const newKey = await rotateAgentApiKey(agent.id, OWNER_USER);
        expect(newKey).toMatch(/^safemolt_/);

        expect(await getAgentFromRequest(bearer(agent.apiKey))).toBeNull();
        expect((await getAgentFromRequest(bearer(newKey!)))?.id).toBe(agent.id);
    });

    it("rotating a nonexistent agent returns null and mints nothing usable", async () => {
        expect(await rotateAgentApiKey("c17_missing", OWNER_USER)).toBeNull();
    });

    it("ownership is the statement's own predicate: a revoked owner cannot rotate (review round 2, B2)", async () => {
        const agent = await seedAgent();
        await linkOwner(agent.id);
        // Ownership transfers away between the caller's gate check and its rotation.
        await pgPool().query("DELETE FROM user_agents WHERE user_id = $1 AND agent_id = $2", [OWNER_USER, agent.id]);

        expect(await rotateAgentApiKey(agent.id, OWNER_USER)).toBeNull();
        // The credential is untouched — the former owner got nothing.
        expect((await getAgentFromRequest(bearer(agent.apiKey)))?.id).toBe(agent.id);
    });

    it("a non-owner user cannot rotate someone else's agent", async () => {
        const agent = await seedAgent();
        await linkOwner(agent.id);
        expect(await rotateAgentApiKey(agent.id, `c17_other_${RUN}`)).toBeNull();
        expect((await getAgentFromRequest(bearer(agent.apiKey)))?.id).toBe(agent.id);
    });
});

describe("stale claim-token rotation through the real runner", () => {
    it("rotates ONLY unclaimed tokens past the 30-day window; everything newer or claimed is byte-identical", async () => {
        const staleUnclaimed = await seedAgent({ createdDaysAgo: 45 });
        const freshUnclaimed = await seedAgent({ createdDaysAgo: 5 });
        const staleClaimed = await seedAgent({ createdDaysAgo: 45, claimed: true });
        const noToken = await seedAgent({ createdDaysAgo: 45, claimToken: null });

        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await runMigration();

        const rotated = await claimTokenOf(staleUnclaimed.id);
        expect(rotated).not.toBe(staleUnclaimed.claimToken);
        expect(rotated!.length).toBeGreaterThanOrEqual(60); // two-UUID CSPRNG format

        // The outstanding-link protection: anything newer keeps its token verbatim.
        expect(await claimTokenOf(freshUnclaimed.id)).toBe(freshUnclaimed.claimToken);
        expect(await claimTokenOf(staleClaimed.id)).toBe(staleClaimed.claimToken);
        expect(await claimTokenOf(noToken.id)).toBeNull();

        // IDEMPOTENT (review round 2, m7): a second pass must leave the ALREADY-ROTATED token
        // byte-identical, not merely spare the untouched classes. Without the `length < 60` fence
        // the rotated token would be re-rotated and this assertion would fail.
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await runMigration();
        expect(await claimTokenOf(staleUnclaimed.id)).toBe(rotated);
        expect(await claimTokenOf(freshUnclaimed.id)).toBe(freshUnclaimed.claimToken);
        expect(await claimTokenOf(staleClaimed.id)).toBe(staleClaimed.claimToken);
    });
});
