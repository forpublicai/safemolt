/**
 * M11-1 C21 `[integration]` — one result, one payout, per registration, on the driver that runs
 * in production.
 *
 * Three claims a mocked `sql` cannot show:
 *
 *  1. **The gated CTE serializes on the registration row.** The transition arm and the result
 *     insert are one statement; the loser of a concurrent completion matches zero rows and writes
 *     nothing. Both public surfaces (route and tool) funnel into this one statement — that is
 *     C2's cure applied to C21's defect — so the race is asserted where it is decided.
 *  2. **A 23505 rolls the transition back with the insert.** For the one shape the gate cannot
 *     stop (a result row already present under a still-actionable registration), the registration
 *     must not end up transitioned with the new result absent.
 *  3. **The migration repairs before it constrains, and refuses what it cannot repair.** Identical
 *     duplicate sets collapse keep-earliest with points recomputed and activity projections swept;
 *     a set that disagrees on the verdict fields raises, records nothing, and waits for a human.
 */
import { join } from "path";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { raceAgainstHeldLock, rejections, runConcurrently } from "./helpers/concurrency";
import { saveEvaluationResult, getEvaluationResultForRegistration } from "@/lib/store/evaluations/db";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");

const connectionString = process.env.POSTGRES_URL as string;
const SCRIPTS_DIR = join(__dirname, "../../../scripts");
const MIGRATION_FILE = "migrate-evaluation-result-unique.sql";
const INDEX_NAME = "idx_eval_results_registration_uniq";

const PREFIX = "c21_";
let seq = 0;

async function seedAgent(suffix: string): Promise<string> {
    const id = `${PREFIX}agent_${suffix}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at)
         VALUES ($1, $1, '', $2, 0, 0, false, NOW())`,
        [id, `${PREFIX}key_${id}`]
    );
    return id;
}

async function seedDefinition(evaluationId: string): Promise<void> {
    await pgPool().query(
        `INSERT INTO evaluation_definitions
           (id, sip_number, name, module, type, status, file_path, executable_handler, executable_script_path, version, created_at, updated_at)
         VALUES ($1, $2, $1, 'core', 'simple_pass_fail', 'active', 'x', 'x', 'x', '1.0.0', NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [evaluationId, 9100 + (seq += 1)]
    );
}

const EVALUATION = `${PREFIX}fixture_eval`;

async function seedRegistration(agentId: string, status = "in_progress"): Promise<string> {
    const id = `${PREFIX}reg_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO evaluation_registrations
           (id, agent_id, evaluation_id, registered_at, status, school_id, school_scope_trusted)
         VALUES ($1, $2, $3, NOW(), $4, 'foundation', true)`,
        [id, agentId, EVALUATION, status]
    );
    return id;
}

async function seedResult(opts: {
    registrationId: string;
    agentId: string;
    passed?: boolean;
    pointsEarned?: number | null;
    completedAt: string;
    proctorAgentId?: string | null;
}): Promise<string> {
    const id = `${PREFIX}res_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO evaluation_results
           (id, registration_id, agent_id, evaluation_id, passed, score, max_score, completed_at,
            points_earned, evaluation_version, school_id, proctor_agent_id)
         VALUES ($1, $2, $3, $4, $5, 7, 10, $6, $7, '1.0.0', 'foundation', $8)`,
        [id, opts.registrationId, opts.agentId, EVALUATION, opts.passed ?? true, opts.completedAt,
         opts.pointsEarned === undefined ? 7 : opts.pointsEarned, opts.proctorAgentId ?? null]
    );
    return id;
}

async function resultRows(registrationId: string): Promise<Array<{ id: string; passed: boolean }>> {
    const { rows } = await pgPool().query<{ id: string; passed: boolean }>(
        "SELECT id, passed FROM evaluation_results WHERE registration_id = $1 ORDER BY completed_at, id",
        [registrationId]
    );
    return rows;
}

async function agentPoints(agentId: string): Promise<number> {
    const { rows } = await pgPool().query<{ points: string }>("SELECT points FROM agents WHERE id = $1", [agentId]);
    return Number(rows[0].points);
}

async function registrationStatus(registrationId: string): Promise<string> {
    const { rows } = await pgPool().query<{ status: string }>(
        "SELECT status FROM evaluation_registrations WHERE id = $1",
        [registrationId]
    );
    return rows[0].status;
}

async function indexShape(): Promise<{ unique: boolean; partial: boolean } | null> {
    const { rows } = await pgPool().query<{ unique: boolean; partial: boolean }>(
        `SELECT i.indisunique AS "unique", i.indpred IS NOT NULL AS partial
         FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = $1`,
        [INDEX_NAME]
    );
    return rows[0] ?? null;
}

async function migrationRecorded(): Promise<boolean> {
    const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
    return (rowCount ?? 0) > 0;
}

function runMigration() {
    return migrate({
        files: [{ file: MIGRATION_FILE, label: "C21 unique result" }],
        dir: SCRIPTS_DIR,
        connectionString,
    });
}

async function cleanUp(): Promise<void> {
    // Live saves record activity under generated `eval_res_*` entity ids, so sweep by actor too.
    await pgPool().query("DELETE FROM activity_events WHERE entity_id LIKE $1 OR actor_id LIKE $1", [`${PREFIX}%`]);
    await pgPool().query("DELETE FROM activity_contexts WHERE activity_id LIKE $1", [`${PREFIX}%`]);
    await pgPool().query("DELETE FROM evaluation_results WHERE registration_id LIKE $1", [`${PREFIX}%`]);
    await pgPool().query("DELETE FROM evaluation_registrations WHERE id LIKE $1", [`${PREFIX}%`]);
    await pgPool().query("DELETE FROM agents WHERE id LIKE $1", [`${PREFIX}%`]);
}

beforeAll(async () => {
    await seedDefinition(EVALUATION);
});

beforeEach(cleanUp);

afterAll(async () => {
    await cleanUp();
    await pgPool().query("DELETE FROM evaluation_definitions WHERE id = $1", [EVALUATION]);
    await closeIntegrationConnections();
});

/**
 * The migration fixtures run first and restore the index before the runtime gates below need it.
 * Seeding a duplicate requires the unique index absent, so each fixture drops it and unrecords the
 * file, and the describe's afterEach reinstates both through the real runner.
 */
describe("the migration: repair, refusal, and the guarded index", () => {
    // These fixtures model the pre-C21 world — multiple result rows per registration — which the
    // round-8 one-pass index also forbids, so both indexes come off and both files re-apply.
    async function dropIndexAndUnrecord(): Promise<void> {
        await pgPool().query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
        await pgPool().query("DROP INDEX IF EXISTS idx_eval_results_one_pass");
        await pgPool().query(
            "DELETE FROM _migrations WHERE filename IN ($1, 'migrate-evaluation-one-pass.sql')",
            [MIGRATION_FILE]
        );
    }

    afterEach(async () => {
        // Whatever the fixture did, leave the database constrained: clear fixture rows (a
        // disagreeing set would make the migration refuse), then re-apply through the real runner.
        await cleanUp();
        await pgPool().query(
            "DELETE FROM _migrations WHERE filename IN ($1, 'migrate-evaluation-one-pass.sql')",
            [MIGRATION_FILE]
        );
        await runMigration();
        await migrate({
            files: [{ file: "migrate-evaluation-one-pass.sql", label: "C21 one pass" }],
            dir: SCRIPTS_DIR,
            connectionString,
        });
        expect(await indexShape()).toEqual({ unique: true, partial: false });
    });

    it("collapses an identical duplicate set keep-earliest, recomputes points, and sweeps projections", async () => {
        await dropIndexAndUnrecord();
        const agent = await seedAgent("repair");
        const registrationId = await seedRegistration(agent, "completed");
        const earliest = await seedResult({ registrationId, agentId: agent, completedAt: "2026-01-01T00:00:00Z" });
        const later = await seedResult({ registrationId, agentId: agent, completedAt: "2026-01-02T00:00:00Z" });
        for (const resultId of [earliest, later]) {
            await pgPool().query(
                `INSERT INTO activity_events (kind, occurred_at, entity_id, title, summary)
                 VALUES ('evaluation_result', NOW(), $1, 't', 's')`,
                [resultId]
            );
            await pgPool().query(
                `INSERT INTO activity_contexts (activity_kind, activity_id, prompt_version, content)
                 VALUES ('evaluation_result', $1, 'v1', 'c')`,
                [resultId]
            );
        }
        // The inflated total the duplicate minted — what the repair must correct.
        await pgPool().query("UPDATE agents SET points = 14 WHERE id = $1", [agent]);

        await runMigration();

        expect((await resultRows(registrationId)).map((r) => r.id)).toEqual([earliest]);
        expect(await agentPoints(agent)).toBe(7);
        const { rows: events } = await pgPool().query(
            "SELECT entity_id FROM activity_events WHERE entity_id IN ($1, $2)",
            [earliest, later]
        );
        expect(events.map((r) => r.entity_id)).toEqual([earliest]);
        const { rows: contexts } = await pgPool().query(
            "SELECT activity_id FROM activity_contexts WHERE activity_id IN ($1, $2)",
            [earliest, later]
        );
        expect(contexts.map((r) => r.activity_id)).toEqual([earliest]);
        expect(await migrationRecorded()).toBe(true);
        expect(await indexShape()).toEqual({ unique: true, partial: false });

        // Idempotent: a second run over repaired data changes nothing (the file was re-unrecorded
        // to force its SQL to actually run, since recorded files are skipped unread).
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await runMigration();
        expect((await resultRows(registrationId)).map((r) => r.id)).toEqual([earliest]);
        expect(await agentPoints(agent)).toBe(7);
    });

    it("refuses a set that disagrees on the verdict, records nothing, and touches no row", async () => {
        await dropIndexAndUnrecord();
        const agent = await seedAgent("manual");
        const registrationId = await seedRegistration(agent, "completed");
        await seedResult({ registrationId, agentId: agent, passed: false, pointsEarned: null, completedAt: "2026-01-01T00:00:00Z" });
        await seedResult({ registrationId, agentId: agent, passed: true, pointsEarned: 7, completedAt: "2026-01-02T00:00:00Z" });

        let failure: Error | null = null;
        await runMigration().catch((error: Error) => { failure = error; });

        expect(failure).not.toBeNull();
        const message = String(failure);
        expect(message).toContain("C21");
        expect(message).toContain(registrationId);
        // Locked decision 5: preflight wording avoids the substrings the runner's dropped swallow
        // filter used to match.
        expect(message.toLowerCase()).not.toContain("duplicate");
        expect(message.toLowerCase()).not.toContain("already exists");

        expect(await migrationRecorded()).toBe(false);
        expect(await resultRows(registrationId)).toHaveLength(2);
        expect(await indexShape()).toBeNull();
    });

    it("routes a cross-agent duplicate to the human even when the verdicts agree", async () => {
        // The pre-C2 tool wrote caller-chosen agent_id straight through, so one registration can
        // carry two same-verdict rows crediting different agents. Auto-collapsing keep-earliest
        // would delete the legitimate later row and leave the forged credit standing — exactly the
        // laundering the manual-decision split exists to prevent.
        await dropIndexAndUnrecord();
        const owner = await seedAgent("owner");
        const impostor = await seedAgent("impostor");
        const registrationId = await seedRegistration(owner, "completed");
        await seedResult({ registrationId, agentId: impostor, completedAt: "2026-01-01T00:00:00Z" });
        await seedResult({ registrationId, agentId: owner, completedAt: "2026-01-02T00:00:00Z" });

        let failure: Error | null = null;
        await runMigration().catch((error: Error) => { failure = error; });

        expect(failure).not.toBeNull();
        expect(String(failure)).toContain("C21");
        expect(String(failure)).toContain(registrationId);
        expect(await migrationRecorded()).toBe(false);
        expect(await resultRows(registrationId)).toHaveLength(2);
    });

    it("fails loudly when the index name is squatted on another table, and records nothing", async () => {
        // With the guard pinned to the target table, a same-named index elsewhere is invisible to
        // it — CREATE IF NOT EXISTS then no-ops by name and the *postcondition* must catch the
        // absence, rolling the whole file back (including its DROP of the plain index).
        await dropIndexAndUnrecord();
        // The pre-migration state this fixture models still has the plain index; the real run
        // dropped it on this database, so reinstate it to observe the rollback preserve it.
        await pgPool().query(
            "CREATE INDEX IF NOT EXISTS idx_eval_results_registration ON evaluation_results (registration_id)"
        );
        await pgPool().query(
            `CREATE UNIQUE INDEX ${INDEX_NAME} ON certification_jobs (registration_id)`
        );

        try {
            let failure: Error | null = null;
            await runMigration().catch((error: Error) => { failure = error; });

            expect(failure).not.toBeNull();
            expect(String(failure)).toContain("postcondition failed");
            expect(await migrationRecorded()).toBe(false);
            // The rollback preserved the plain index the file would otherwise have dropped.
            const { rows } = await pgPool().query(
                "SELECT 1 FROM pg_indexes WHERE indexname = 'idx_eval_results_registration'"
            );
            expect(rows).toHaveLength(1);
        } finally {
            await pgPool().query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
        }
        await runMigration();
        expect(await indexShape()).toEqual({ unique: true, partial: false });
    });

    it("raises on a same-named index of the wrong shape instead of skipping past it", async () => {
        await dropIndexAndUnrecord();
        // The decoy IF NOT EXISTS would silently keep: right name, partial predicate — it
        // constrains almost nothing.
        await pgPool().query(
            `CREATE UNIQUE INDEX ${INDEX_NAME} ON evaluation_results (registration_id) WHERE passed = true`
        );

        try {
            let failure: Error | null = null;
            await runMigration().catch((error: Error) => { failure = error; });

            expect(failure).not.toBeNull();
            expect(String(failure)).toContain("wrong shape");
            expect(await migrationRecorded()).toBe(false);
        } finally {
            // A decoy left behind fails every later run's prepare — always drop it, even when an
            // assertion above did.
            await pgPool().query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
        }
        await runMigration();
        expect(await indexShape()).toEqual({ unique: true, partial: false });
    });
});

describe("one passed result per (agent, evaluation) — the round-8 index and its refusals", () => {
    const ONE_PASS_FILE = "migrate-evaluation-one-pass.sql";
    const ONE_PASS_INDEX = "idx_eval_results_one_pass";

    function runOnePassMigration() {
        return migrate({
            files: [{ file: ONE_PASS_FILE, label: "C21 one pass" }],
            dir: SCRIPTS_DIR,
            connectionString,
        });
    }

    async function onePassRecorded(): Promise<boolean> {
        const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [ONE_PASS_FILE]);
        return (rowCount ?? 0) > 0;
    }

    afterEach(async () => {
        await cleanUp();
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [ONE_PASS_FILE]);
        await runOnePassMigration();
    });

    it("the migration refuses a multi-passed set — a passed row is a public score no rule may delete", async () => {
        await pgPool().query(`DROP INDEX IF EXISTS ${ONE_PASS_INDEX}`);
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [ONE_PASS_FILE]);
        const agent = await seedAgent("multipass");
        const regA = await seedRegistration(agent, "completed");
        const regB = await seedRegistration(agent, "completed");
        await seedResult({ registrationId: regA, agentId: agent, completedAt: "2026-01-01T00:00:00Z" });
        await seedResult({ registrationId: regB, agentId: agent, completedAt: "2026-01-02T00:00:00Z" });

        let failure: Error | null = null;
        await runOnePassMigration().catch((error: Error) => { failure = error; });

        expect(failure).not.toBeNull();
        const message = String(failure);
        expect(message).toContain("C21");
        expect(message).toContain(agent);
        expect(message.toLowerCase()).not.toContain("duplicate");
        expect(message.toLowerCase()).not.toContain("already exists");
        expect(await onePassRecorded()).toBe(false);
        expect(await resultRows(regA)).toHaveLength(1);
        expect(await resultRows(regB)).toHaveLength(1);
    });

    it("the db registration insert refuses a prior pass — the authorization pre-check cannot go stale", async () => {
        const { registerForEvaluation } = await import("@/lib/store/evaluations/db");
        const agent = await seedAgent("regGate");
        const registrationId = await seedRegistration(agent);
        const saved = await saveEvaluationResult({ registrationId, agentId: agent, evaluationId: EVALUATION, passed: true, score: 7, maxScore: 10 });
        expect(saved.outcome).toBe("created");

        expect(await registerForEvaluation(agent, EVALUATION)).toBeNull();
    });

    it("a second passing save on a slipped-through registration trips the index and pays nothing", async () => {
        // A registration inserted before the pass committed (the statement-level gate's snapshot
        // window). The index turns its completion into a 23505; the statement rolls back whole, so
        // the registration is not transitioned and no second payout lands.
        const agent = await seedAgent("slipped");
        const passedReg = await seedRegistration(agent, "completed");
        await seedResult({ registrationId: passedReg, agentId: agent, completedAt: "2026-01-01T00:00:00Z" });
        await pgPool().query("UPDATE agents SET points = 7 WHERE id = $1", [agent]);
        const slipped = await seedRegistration(agent);

        const saved = await saveEvaluationResult({ registrationId: slipped, agentId: agent, evaluationId: EVALUATION, passed: true, score: 7, maxScore: 10 });

        expect(saved.outcome).toBe("not_actionable");
        expect(await registrationStatus(slipped)).toBe("in_progress");
        expect(await resultRows(slipped)).toHaveLength(0);
        expect(await agentPoints(agent)).toBe(7);

        // A failed verdict still records — the invariant covers the payout, not the attempt.
        const failed = await saveEvaluationResult({ registrationId: slipped, agentId: agent, evaluationId: EVALUATION, passed: false, score: 0, maxScore: 10 });
        expect(failed.outcome).toBe("created");
    });
});

describe("the gated save, raced on the Neon driver", () => {
    it("pays exactly once for two concurrent completions of one registration", async () => {
        const agent = await seedAgent("race");
        const registrationId = await seedRegistration(agent);

        const outcomes = await runConcurrently([
            () => saveEvaluationResult({ registrationId, agentId: agent, evaluationId: EVALUATION, passed: true, score: 7, maxScore: 10 }),
            () => saveEvaluationResult({ registrationId, agentId: agent, evaluationId: EVALUATION, passed: true, score: 7, maxScore: 10 }),
        ]);

        expect(rejections(outcomes)).toEqual([]);
        const values = outcomes.map((o) => (o.ok ? o.value : null));
        expect(values.filter((v) => v?.outcome === "created")).toHaveLength(1);
        expect(values.filter((v) => v?.outcome === "already_complete")).toHaveLength(1);
        expect(await resultRows(registrationId)).toHaveLength(1);
        // Asserted on the points, not merely count(*) — the count can be right while the sum is
        // wrong, and the sum is the mint.
        expect(await agentPoints(agent)).toBe(7);
        expect(await registrationStatus(registrationId)).toBe("completed");
    });

    it("pays exactly once when the two completions carry different proctors — the cross-surface shape", async () => {
        // Route and tool both funnel into this one statement after their own authorization (C2);
        // what distinguishes the surfaces at the store is the proctor identity they pass. Exactly
        // one may win, and the survivor's proctor is the winner's.
        const candidate = await seedAgent("cand");
        const routeProctor = await seedAgent("proc_route");
        const toolProctor = await seedAgent("proc_tool");
        const registrationId = await seedRegistration(candidate);

        const outcomes = await runConcurrently([
            () => saveEvaluationResult({ registrationId, agentId: candidate, evaluationId: EVALUATION, passed: true, score: 7, maxScore: 10, proctorAgentId: routeProctor }),
            () => saveEvaluationResult({ registrationId, agentId: candidate, evaluationId: EVALUATION, passed: true, score: 7, maxScore: 10, proctorAgentId: toolProctor }),
        ]);

        const values = outcomes.map((o) => (o.ok ? o.value : null));
        const winners = values.filter((v) => v?.outcome === "created");
        expect(winners).toHaveLength(1);
        expect(values.filter((v) => v?.outcome === "already_complete")).toHaveLength(1);

        const { rows } = await pgPool().query<{ proctor_agent_id: string }>(
            "SELECT proctor_agent_id FROM evaluation_results WHERE registration_id = $1",
            [registrationId]
        );
        expect(rows).toHaveLength(1);
        expect([routeProctor, toolProctor]).toContain(rows[0].proctor_agent_id);
        expect(await agentPoints(candidate)).toBe(7);
    });

    it("blocks on a held registration-row lock and writes nothing once the holder's transition commits", async () => {
        const agent = await seedAgent("lock");
        const registrationId = await seedRegistration(agent);

        const contention = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query(
                    "UPDATE evaluation_registrations SET status = 'completed', completed_at = NOW() WHERE id = $1",
                    [registrationId]
                );
            },
            contend: () => saveEvaluationResult({ registrationId, agentId: agent, evaluationId: EVALUATION, passed: true, score: 7, maxScore: 10 }),
            contenderMarker: "INSERT INTO evaluation_results",
        });

        expect(contention.observedBlocked).toBe(true);
        // The holder completed the registration without a result (it modelled a concurrent
        // transition, not a full save), so the honest classification is not_actionable — and
        // nothing was written or paid.
        expect(contention.result.outcome).toBe("not_actionable");
        expect(await resultRows(registrationId)).toHaveLength(0);
        expect(await agentPoints(agent)).toBe(0);
    });

    it("rolls the transition back with the insert when the unique index fires", async () => {
        // The one shape the CTE gate cannot stop: a result row already present under a
        // still-actionable registration (baseline report 7's shape). The 23505 must take the
        // transition down with the insert — a transitioned registration with the new result absent
        // would be exactly the committable partial state this chunk forbids.
        const agent = await seedAgent("partial");
        const registrationId = await seedRegistration(agent);
        const existing = await seedResult({ registrationId, agentId: agent, completedAt: "2026-01-01T00:00:00Z" });

        const saved = await saveEvaluationResult({ registrationId, agentId: agent, evaluationId: EVALUATION, passed: true, score: 7, maxScore: 10 });

        expect(saved.outcome).toBe("already_complete");
        if (saved.outcome === "already_complete") expect(saved.existing.id).toBe(existing);
        expect(await registrationStatus(registrationId)).toBe("in_progress");
        expect(await resultRows(registrationId)).toHaveLength(1);
    });

    it("returns the standing result on a sequential re-submit and moves no points", async () => {
        const agent = await seedAgent("resubmit");
        const registrationId = await seedRegistration(agent);

        const first = await saveEvaluationResult({ registrationId, agentId: agent, evaluationId: EVALUATION, passed: true, score: 7, maxScore: 10 });
        if (first.outcome !== "created") throw new Error(`expected created, got ${first.outcome}`);
        expect(await agentPoints(agent)).toBe(7);

        const second = await saveEvaluationResult({ registrationId, agentId: agent, evaluationId: EVALUATION, passed: true, score: 7, maxScore: 10 });
        expect(second.outcome).toBe("already_complete");
        if (second.outcome === "already_complete") expect(second.existing.id).toBe(first.resultId);
        expect(await agentPoints(agent)).toBe(7);
        expect(await getEvaluationResultForRegistration(registrationId).then((r) => r?.id)).toBe(first.resultId);
    });

    it("records a failed completion once and pays nothing", async () => {
        const agent = await seedAgent("fail");
        const registrationId = await seedRegistration(agent);

        const saved = await saveEvaluationResult({ registrationId, agentId: agent, evaluationId: EVALUATION, passed: false, score: 0, maxScore: 10 });

        expect(saved.outcome).toBe("created");
        expect(await registrationStatus(registrationId)).toBe("failed");
        expect(await agentPoints(agent)).toBe(0);
        const again = await saveEvaluationResult({ registrationId, agentId: agent, evaluationId: EVALUATION, passed: false, score: 0, maxScore: 10 });
        expect(again.outcome).toBe("already_complete");
    });
});
