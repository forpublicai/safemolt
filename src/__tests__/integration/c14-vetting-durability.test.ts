/**
 * M11-1 C14 `[integration]` — durable vetting challenges + atomic completion.
 *
 * The defect: challenges lived in a process-local Map even in DB mode (random 404s across
 * serverless instances), and completion consumed the challenge FIRST across many auto-committed
 * calls, so any later failure burned a valid challenge. These gates need the real database: the
 * claims are about what a second driver handle sees, what one transaction batch commits or rolls
 * back, and what the FK cascade does.
 *
 * Challenges are seeded with generous expiry via SQL (the production 15-second TTL would make a
 * loaded CI run flake); the one round-trip through `createVettingChallenge` asserts persistence
 * of the real writer's row shape.
 */
import { join } from "path";
import { closeIntegrationConnections, neonSql, pgPool } from "./helpers/db";
import { runConcurrently } from "./helpers/concurrency";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");
const C14_SCRIPTS_DIR = join(__dirname, "../../../scripts");
const C14_MIGRATION_FILE = "migrate-vetting-challenges.sql";
import {
    completeVetting,
    createVettingChallenge,
    getVettingChallenge,
    pruneExpiredVettingChallenges,
} from "@/lib/store/agents/db";
import { computeExpectedHash } from "@/lib/vetting";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

async function seedAgent(): Promise<{ id: string; apiKey: string }> {
    const id = `c14_agent_${RUN}_${(seq += 1)}`;
    const apiKey = `c14_key_${RUN}_${seq}`;
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted)
         VALUES ($1, $1, '', $2, 0, 0, false, NOW(), false)`,
        [id, apiKey]
    );
    return { id, apiKey };
}

async function seedChallenge(
    agentId: string,
    options: { expiresInMs?: number; consumed?: boolean } = {}
): Promise<{ id: string; values: number[]; nonce: string; hash: string }> {
    const id = `c14_vc_${RUN}_${(seq += 1)}`;
    const values = [3, 1, 2];
    const nonce = `nonce_${id}`;
    const hash = computeExpectedHash(values, nonce);
    await pgPool().query(
        `INSERT INTO vetting_challenges (id, agent_id, "values", nonce, expected_hash, created_at, expires_at, consumed_at)
         VALUES ($1, $2, $3::jsonb, $4, $5, NOW(), NOW() + make_interval(secs => $6), $7)`,
        [id, agentId, JSON.stringify(values), nonce, hash, (options.expiresInMs ?? 300_000) / 1000, options.consumed ? new Date() : null]
    );
    return { id, values, nonce, hash };
}

async function agentRow(agentId: string) {
    const { rows } = await pgPool().query<{ is_vetted: boolean; identity_md: string | null; points: string }>(
        "SELECT is_vetted, identity_md, points FROM agents WHERE id = $1",
        [agentId]
    );
    return rows[0];
}

async function bootstrapRows(agentId: string) {
    const { rows: regs } = await pgPool().query<{ id: string; evaluation_id: string; status: string }>(
        "SELECT id, evaluation_id, status FROM evaluation_registrations WHERE agent_id = $1 ORDER BY evaluation_id",
        [agentId]
    );
    const { rows: results } = await pgPool().query<{ id: string; evaluation_id: string; passed: boolean; points_earned: string | null }>(
        "SELECT id, evaluation_id, passed, points_earned FROM evaluation_results WHERE agent_id = $1 ORDER BY evaluation_id",
        [agentId]
    );
    return { regs, results };
}

async function challengeConsumedAt(id: string): Promise<Date | null> {
    const { rows } = await pgPool().query<{ consumed_at: Date | null }>(
        "SELECT consumed_at FROM vetting_challenges WHERE id = $1",
        [id]
    );
    return rows[0]?.consumed_at ?? null;
}

afterAll(async () => {
    await pgPool().query("DELETE FROM activity_events WHERE actor_id LIKE $1", [`c14_agent_${RUN}%`]);
    await pgPool().query("DELETE FROM evaluation_results WHERE agent_id LIKE $1", [`c14_agent_${RUN}%`]);
    await pgPool().query("DELETE FROM evaluation_registrations WHERE agent_id LIKE $1", [`c14_agent_${RUN}%`]);
    await pgPool().query("DELETE FROM vetting_challenges WHERE id LIKE $1", [`c14_vc_${RUN}%`]);
    // The route test's ensureGeneralGroup follow-up can leave a c14 agent owning the shared
    // `general` group (RESTRICT FK). Re-point ownership to a keeper row this suite never deletes.
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted)
         VALUES ('c14keeper', 'c14keeper', '', 'c14keeper_key', 0, 0, false, NOW(), true)
         ON CONFLICT (id) DO NOTHING`
    );
    await pgPool().query("UPDATE groups SET owner_id = 'c14keeper' WHERE owner_id LIKE $1", [`c14_agent_${RUN}%`]);
    await pgPool().query("DELETE FROM group_members WHERE agent_id LIKE $1", [`c14_agent_${RUN}%`]);
    await pgPool().query("DELETE FROM agents WHERE id LIKE $1", [`c14_agent_${RUN}%`]);
    await closeIntegrationConnections();
});

describe("durable challenges", () => {
    it("a challenge created by the store writer is readable through a second driver handle — no 404", async () => {
        const agent = await seedAgent();
        const challenge = await createVettingChallenge(agent.id);

        const rows = await neonSql()`SELECT id, agent_id, "values", nonce FROM vetting_challenges WHERE id = ${challenge.id}`;
        expect(rows).toHaveLength(1);
        expect(rows[0].agent_id).toBe(agent.id);
        expect(rows[0].values).toEqual(challenge.values);

        // And the store read maps it back faithfully.
        const read = await getVettingChallenge(challenge.id);
        expect(read?.expectedHash).toBe(challenge.expectedHash);
        expect(read?.consumed).toBe(false);
    });
});

describe("atomic completion", () => {
    it("fresh agent: one call vets, bootstraps both evaluations terminally, recomputes points, consumes", async () => {
        const agent = await seedAgent();
        const challenge = await seedChallenge(agent.id);

        const outcome = await completeVetting(agent.id, challenge.id, "# identity\n");
        expect(outcome.outcome).toBe("completed");
        if (outcome.outcome !== "completed") throw new Error("unreachable");
        expect(outcome.bootstrap.map((b) => b.evaluationId).sort()).toEqual(["identity-check", "poaw"]);

        const stored = await agentRow(agent.id);
        expect(stored.is_vetted).toBe(true);
        expect(stored.identity_md).toBe("# identity\n");

        const { regs, results } = await bootstrapRows(agent.id);
        expect(regs.map((r) => r.evaluation_id)).toEqual(["identity-check", "poaw"]);
        expect(regs.every((r) => r.status === "completed")).toBe(true);
        expect(results).toHaveLength(2);
        const expectedPoints = results.reduce((sum, r) => sum + Number(r.points_earned ?? 0), 0);
        expect(Number(stored.points)).toBe(expectedPoints);
        expect(await challengeConsumedAt(challenge.id)).not.toBeNull();
    });

    it("replay is refused: second completion of a consumed challenge writes nothing", async () => {
        const agent = await seedAgent();
        const challenge = await seedChallenge(agent.id);
        await completeVetting(agent.id, challenge.id, "first");
        const before = await bootstrapRows(agent.id);

        const replay = await completeVetting(agent.id, challenge.id, "second");
        expect(replay.outcome).toBe("unavailable");

        const after = await bootstrapRows(agent.id);
        expect(after.regs).toHaveLength(before.regs.length);
        expect(after.results).toHaveLength(before.results.length);
        expect((await agentRow(agent.id)).identity_md).toBe("first");
    });

    it("an expired challenge is refused with nothing written", async () => {
        const agent = await seedAgent();
        const challenge = await seedChallenge(agent.id, { expiresInMs: -1000 });

        expect((await completeVetting(agent.id, challenge.id, "x")).outcome).toBe("unavailable");
        expect((await agentRow(agent.id)).is_vetted).toBe(false);
        expect(await challengeConsumedAt(challenge.id)).toBeNull();
    });

    it("concurrent completions of ONE challenge admit exactly one caller", async () => {
        const agent = await seedAgent();
        const challenge = await seedChallenge(agent.id);

        const outcomes = await runConcurrently(
            Array.from({ length: 4 }, () => () => completeVetting(agent.id, challenge.id, "raced"))
        );
        const completed = outcomes.filter((o) => o.ok && o.value.outcome === "completed");
        expect(completed).toHaveLength(1);

        const { regs, results } = await bootstrapRows(agent.id);
        expect(regs).toHaveLength(2);
        expect(results).toHaveLength(2);
    });

    it("two DIFFERENT valid challenges completed concurrently produce exactly one bootstrap set", async () => {
        const agent = await seedAgent();
        const [a, b] = await Promise.all([seedChallenge(agent.id), seedChallenge(agent.id)]);

        // The agent-row lock is what serializes these — the active-registration index covers only
        // non-terminal rows and cannot.
        await runConcurrently([
            () => completeVetting(agent.id, a.id, "a"),
            () => completeVetting(agent.id, b.id, "b"),
        ]);

        const { regs, results } = await bootstrapRows(agent.id);
        expect(regs).toHaveLength(2); // one per bootstrap evaluation, never four
        expect(results).toHaveLength(2);
        expect((await agentRow(agent.id)).is_vetted).toBe(true);
    });

    it("a pre-registered agent reuses its active registration with no unique-index violation", async () => {
        const agent = await seedAgent();
        const regId = `c14_prereg_${RUN}`;
        await pgPool().query(
            `INSERT INTO evaluation_registrations (id, agent_id, evaluation_id, registered_at, status)
             VALUES ($1, $2, 'poaw', NOW(), 'registered')`,
            [regId, agent.id]
        );
        const challenge = await seedChallenge(agent.id);
        const outcome = await completeVetting(agent.id, challenge.id, "x");
        expect(outcome.outcome).toBe("completed");

        const { rows } = await pgPool().query(
            "SELECT id, status FROM evaluation_registrations WHERE agent_id = $1 AND evaluation_id = 'poaw'",
            [agent.id]
        );
        expect(rows).toHaveLength(1);
        expect(rows[0].id).toBe(regId);
        expect(rows[0].status).toBe("completed");
    });

    it("an already-passed bootstrap evaluation gains no second registration or result", async () => {
        const agent = await seedAgent();
        const first = await seedChallenge(agent.id);
        await completeVetting(agent.id, first.id, "x");
        const before = await bootstrapRows(agent.id);

        const second = await seedChallenge(agent.id);
        const outcome = await completeVetting(agent.id, second.id, "y");
        expect(outcome.outcome).toBe("completed");
        if (outcome.outcome !== "completed") throw new Error("unreachable");
        expect(outcome.bootstrap).toHaveLength(0);

        const after = await bootstrapRows(agent.id);
        expect(after.regs).toHaveLength(before.regs.length);
        expect(after.results).toHaveLength(before.results.length);
    });

    it("failure injection: a mid-batch constraint failure rolls everything back and leaves the challenge retryable", async () => {
        const agent = await seedAgent();
        // Poison: the agent's active poaw registration already carries a FAILED result, so the
        // batch's result insert for that same registration violates C21's unique registration_id
        // index — a genuine post-lock failure boundary. (The batch's own passed-row guard cannot
        // see it: the guard checks for a PASSED row.)
        const regId = `c14_poison_${RUN}`;
        await pgPool().query(
            `INSERT INTO evaluation_registrations (id, agent_id, evaluation_id, registered_at, status)
             VALUES ($1, $2, 'poaw', NOW(), 'registered')`,
            [regId, agent.id]
        );
        await pgPool().query(
            `INSERT INTO evaluation_results (id, registration_id, agent_id, evaluation_id, passed, completed_at, evaluation_version)
             VALUES ($1, $2, $3, 'poaw', false, NOW(), '1.0.0')`,
            [`c14_poison_res_${RUN}`, regId, agent.id]
        );

        const challenge = await seedChallenge(agent.id);
        await expect(completeVetting(agent.id, challenge.id, "x")).rejects.toMatchObject({ code: "23505" });

        // Nothing committed: unvetted, unconsumed, no partial bootstrap.
        expect((await agentRow(agent.id)).is_vetted).toBe(false);
        expect(await challengeConsumedAt(challenge.id)).toBeNull();
        const { results } = await bootstrapRows(agent.id);
        expect(results.filter((r) => r.passed)).toHaveLength(0);

        // Retryable: clear the poisoned result and the same challenge completes.
        await pgPool().query("DELETE FROM evaluation_results WHERE id = $1", [`c14_poison_res_${RUN}`]);
        const retry = await completeVetting(agent.id, challenge.id, "x");
        expect(retry.outcome).toBe("completed");
    });
});

describe("route-level lost-response retry", () => {
    it("re-submitting a committed completion returns idempotent success with no duplicates", async () => {
        const agent = await seedAgent();
        const challenge = await seedChallenge(agent.id);
        const { POST } = await import("@/app/api/v1/agents/vetting/complete/route");

        const makeRequest = () =>
            new Request("http://localhost/api/v1/agents/vetting/complete", {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${agent.apiKey}` },
                body: JSON.stringify({ challenge_id: challenge.id, hash: challenge.hash, identity_md: "# me\n" }),
            });

        const first = await POST(makeRequest() as never);
        expect(first.status).toBe(200);
        const before = await bootstrapRows(agent.id);

        // The commit landed but (say) the response never arrived — the agent retries verbatim.
        const retry = await POST(makeRequest() as never);
        expect(retry.status).toBe(200);
        const retryBody = await retry.json();
        expect(retryBody.success).toBe(true);
        expect(retryBody.agent.is_vetted).toBe(true);

        const after = await bootstrapRows(agent.id);
        expect(after.regs).toHaveLength(before.regs.length);
        expect(after.results).toHaveLength(before.results.length);

        // A wrong-hash replay of the same consumed challenge is still an error, not a success.
        const forged = await POST(
            new Request("http://localhost/api/v1/agents/vetting/complete", {
                method: "POST",
                headers: { "content-type": "application/json", authorization: `Bearer ${agent.apiKey}` },
                body: JSON.stringify({ challenge_id: challenge.id, hash: "0".repeat(64), identity_md: "# me\n" }),
            }) as never
        );
        expect(forged.status).toBe(410);
    });
});

describe("housekeeping", () => {
    it("pruning removes only challenges expired past the retention window", async () => {
        const agent = await seedAgent();
        const stale = await seedChallenge(agent.id, { expiresInMs: -48 * 3_600_000 });
        const recent = await seedChallenge(agent.id, { expiresInMs: -3_600_000 });

        await pruneExpiredVettingChallenges(24 * 3_600_000);

        const { rows } = await pgPool().query("SELECT id FROM vetting_challenges WHERE id = ANY($1)", [
            [stale.id, recent.id],
        ]);
        expect(rows.map((r) => r.id)).toEqual([recent.id]);
    });

    it("agent deletion cascades challenge rows (FK ON DELETE CASCADE)", async () => {
        const agent = await seedAgent();
        const challenge = await seedChallenge(agent.id);
        await pgPool().query("DELETE FROM agents WHERE id = $1", [agent.id]);
        const { rows } = await pgPool().query("SELECT id FROM vetting_challenges WHERE id = $1", [challenge.id]);
        expect(rows).toHaveLength(0);
    });
});

describe("C14 migration through the real runner (M11-1b review B6)", () => {
    it("applies clean and records, executing its DDL and the strengthened postconditions", async () => {
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [C14_MIGRATION_FILE]);
        await migrate({ files: [{ file: C14_MIGRATION_FILE, label: "C14 vetting challenges" }], dir: C14_SCRIPTS_DIR, connectionString: process.env.POSTGRES_URL });
        const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [C14_MIGRATION_FILE]);
        expect(rowCount).toBe(1);
    });
});

describe("C14 migration postconditions", () => {
    it("vetting_challenges has the batch's load-bearing columns and the cascading FK", async () => {
        const { rows: cols } = await pgPool().query<{ column_name: string }>(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'vetting_challenges'
             ORDER BY column_name`
        );
        expect(cols.map((c) => c.column_name)).toEqual(
            ["agent_id", "consumed_at", "created_at", "expected_hash", "expires_at", "fetched_at", "id", "nonce", "values"].sort()
        );

        const { rows: fk } = await pgPool().query(
            `SELECT 1 FROM pg_constraint
             WHERE conrelid = 'public.vetting_challenges'::regclass
               AND contype = 'f' AND confrelid = 'public.agents'::regclass AND confdeltype = 'c'`
        );
        expect(fk).toHaveLength(1);
    });
});
