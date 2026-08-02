/**
 * M11-1 C22 `[integration]` — one live certification job per registration, and a lease the paid
 * call is fenced on, proven on the driver production runs.
 *
 * What a mocked `sql` cannot show here:
 *  1. **The partial unique index constrains the race**, and only over live statuses — a losing
 *     concurrent insert trips 23505 and gets the winner back, while a completed job blocks
 *     nothing (retries stay legal).
 *  2. **`submitted → judging` admits exactly one claimant**, decided by the row, not by a check.
 *  3. **The token fence outlives the claimant**: after a reclaim, the stalled claimant's terminal
 *     writes match zero rows — the reclaimer's do not.
 *  4. **The migration repairs keep-earliest before constraining** (production report 10's shape:
 *     several pending jobs on one registration), and refuses a same-named index of the wrong
 *     shape rather than skipping past it.
 */
import { join } from "path";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { rejections, runConcurrently } from "./helpers/concurrency";
import {
    createCertificationJob,
    getLiveCertificationJobForRegistration,
    submitCertificationTranscript,
    claimCertificationJobForJudging,
    renewCertificationJudgeLease,
    completeCertificationJudging,
    failCertificationJudging,
    reclaimExpiredCertificationJobs,
    listStaleSubmittedCertificationJobs,
} from "@/lib/store/evaluations/db";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");

const connectionString = process.env.POSTGRES_URL as string;
const SCRIPTS_DIR = join(__dirname, "../../../scripts");
const MIGRATION_FILE = "migrate-certification-job-lease.sql";
const INDEX_NAME = "idx_cert_jobs_live_registration";

const PREFIX = "c22_";
const EVALUATION = `${PREFIX}fixture_eval`;
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

async function seedRegistration(agentId: string): Promise<string> {
    const id = `${PREFIX}reg_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO evaluation_registrations
           (id, agent_id, evaluation_id, registered_at, status, school_id, school_scope_trusted)
         VALUES ($1, $2, $3, NOW(), 'in_progress', 'foundation', true)`,
        [id, agentId, EVALUATION]
    );
    return id;
}

async function seedJob(opts: {
    registrationId: string;
    agentId: string;
    status?: string;
    createdAt?: string;
    submittedAt?: string;
    judgeToken?: string | null;
    judgeClaimExpiresAt?: string | null;
}): Promise<string> {
    const id = `${PREFIX}job_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO certification_jobs
           (id, registration_id, agent_id, evaluation_id, nonce, nonce_expires_at, status, created_at,
            submitted_at, judge_token, judge_claim_expires_at)
         VALUES ($1, $2, $3, $4, $5, NOW() + interval '30 minutes', $6, $7, $8, $9, $10)`,
        [id, opts.registrationId, opts.agentId, EVALUATION, `${PREFIX}nonce_${seq}`,
         opts.status ?? "pending", opts.createdAt ?? new Date().toISOString(),
         opts.submittedAt ?? null, opts.judgeToken ?? null, opts.judgeClaimExpiresAt ?? null]
    );
    return id;
}

async function jobStatus(jobId: string): Promise<string> {
    const { rows } = await pgPool().query<{ status: string }>(
        "SELECT status FROM certification_jobs WHERE id = $1",
        [jobId]
    );
    return rows[0].status;
}

async function liveJobIds(registrationId: string): Promise<string[]> {
    const { rows } = await pgPool().query<{ id: string }>(
        `SELECT id FROM certification_jobs
         WHERE registration_id = $1 AND status IN ('pending', 'submitted', 'judging')
         ORDER BY created_at, id`,
        [registrationId]
    );
    return rows.map((r) => r.id);
}

async function indexPredicate(): Promise<string | null> {
    const { rows } = await pgPool().query<{ predicate: string | null; unique: boolean }>(
        `SELECT pg_get_expr(i.indpred, i.indrelid) AS predicate, i.indisunique AS "unique"
         FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
         JOIN pg_namespace n ON n.oid = c.relnamespace
         WHERE n.nspname = 'public' AND c.relname = $1`,
        [INDEX_NAME]
    );
    if (!rows[0]) return null;
    return rows[0].unique ? rows[0].predicate : `NON-UNIQUE:${rows[0].predicate}`;
}

const CANONICAL_PREDICATE = "(status = ANY (ARRAY['pending'::text, 'submitted'::text, 'judging'::text]))";

async function migrationRecorded(): Promise<boolean> {
    const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
    return (rowCount ?? 0) > 0;
}

function runMigration() {
    return migrate({
        files: [{ file: MIGRATION_FILE, label: "C22 job lease" }],
        dir: SCRIPTS_DIR,
        connectionString,
    });
}

async function cleanUp(): Promise<void> {
    await pgPool().query("DELETE FROM certification_jobs WHERE registration_id LIKE $1", [`${PREFIX}%`]);
    await pgPool().query("DELETE FROM evaluation_results WHERE registration_id LIKE $1", [`${PREFIX}%`]);
    await pgPool().query("DELETE FROM evaluation_registrations WHERE id LIKE $1", [`${PREFIX}%`]);
    await pgPool().query("DELETE FROM agents WHERE id LIKE $1", [`${PREFIX}%`]);
}

beforeAll(async () => {
    await pgPool().query(
        `INSERT INTO evaluation_definitions
           (id, sip_number, name, module, type, status, file_path, executable_handler, executable_script_path, version, created_at, updated_at)
         VALUES ($1, 9200, $1, 'core', 'agent_certification', 'active', 'x', 'x', 'x', '1.0.0', NOW(), NOW())
         ON CONFLICT (id) DO NOTHING`,
        [EVALUATION]
    );
});

beforeEach(cleanUp);

afterAll(async () => {
    await cleanUp();
    await pgPool().query("DELETE FROM evaluation_definitions WHERE id = $1", [EVALUATION]);
    await closeIntegrationConnections();
});

describe("the migration: keep-earliest repair and the guarded partial index", () => {
    afterEach(async () => {
        // Leave the database constrained whatever the fixture did: clear fixture rows, force the
        // file to re-run (recorded files are skipped unread), and re-apply through the real runner.
        await cleanUp();
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await runMigration();
        expect(await indexPredicate()).toBe(CANONICAL_PREDICATE);
    });

    it("keeps the earliest live job, expires the rest, and is idempotent", async () => {
        await pgPool().query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        const agent = await seedAgent("repair");
        const registrationId = await seedRegistration(agent);
        // Production report 10's shape: several pending jobs accumulated by looping `start`.
        const earliest = await seedJob({ registrationId, agentId: agent, createdAt: "2026-01-01T00:00:00Z" });
        const middle = await seedJob({ registrationId, agentId: agent, createdAt: "2026-01-02T00:00:00Z" });
        const latest = await seedJob({ registrationId, agentId: agent, createdAt: "2026-01-03T00:00:00Z" });

        await runMigration();

        expect(await liveJobIds(registrationId)).toEqual([earliest]);
        expect(await jobStatus(middle)).toBe("expired");
        expect(await jobStatus(latest)).toBe("expired");
        expect(await migrationRecorded()).toBe(true);
        expect(await indexPredicate()).toBe(CANONICAL_PREDICATE);

        // Idempotent: re-running over repaired data changes nothing.
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await runMigration();
        expect(await liveJobIds(registrationId)).toEqual([earliest]);
    });

    it("raises on a same-named index of the wrong shape instead of skipping past it", async () => {
        await pgPool().query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        // The decoy IF NOT EXISTS would silently keep: right name, but predicated on one status
        // only, so `start`'s accumulation defect would stay open for submitted/judging jobs.
        await pgPool().query(
            `CREATE UNIQUE INDEX ${INDEX_NAME} ON certification_jobs (registration_id) WHERE status = 'pending'`
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
        expect(await indexPredicate()).toBe(CANONICAL_PREDICATE);
    });
});

describe("the live-job index under concurrency", () => {
    it("admits one of two concurrent creates and hands the loser the winner's job", async () => {
        const agent = await seedAgent("create");
        const registrationId = await seedRegistration(agent);

        const outcomes = await runConcurrently([
            () => createCertificationJob(registrationId, agent, EVALUATION, `${PREFIX}nonce_a_${(seq += 1)}`, new Date(Date.now() + 60_000)),
            () => createCertificationJob(registrationId, agent, EVALUATION, `${PREFIX}nonce_b_${(seq += 1)}`, new Date(Date.now() + 60_000)),
        ]);

        expect(rejections(outcomes)).toEqual([]);
        const ids = outcomes.map((o) => (o.ok ? o.value.id : null));
        expect(new Set(ids).size).toBe(1);
        expect(await liveJobIds(registrationId)).toHaveLength(1);
    });

    it("does not block a fresh attempt once the previous job is terminal", async () => {
        const agent = await seedAgent("retry");
        const registrationId = await seedRegistration(agent);
        const done = await seedJob({ registrationId, agentId: agent, status: "completed" });

        const fresh = await createCertificationJob(registrationId, agent, EVALUATION, `${PREFIX}nonce_${(seq += 1)}`, new Date(Date.now() + 60_000));

        expect(fresh.id).not.toBe(done);
        expect(await liveJobIds(registrationId)).toEqual([fresh.id]);
    });
});

describe("the judging lease on the Neon driver", () => {
    async function submittedJob(): Promise<{ registrationId: string; jobId: string }> {
        const agent = await seedAgent("lease");
        const registrationId = await seedRegistration(agent);
        const job = await createCertificationJob(registrationId, agent, EVALUATION, `${PREFIX}nonce_${(seq += 1)}`, new Date(Date.now() + 60_000));
        const accepted = await submitCertificationTranscript(job.id, [{ promptId: "p1", prompt: "q", response: "a" }], new Date().toISOString());
        expect(accepted).toBe(true);
        return { registrationId, jobId: job.id };
    }

    it("admits exactly one of two concurrent claimants", async () => {
        const { jobId } = await submittedJob();

        const outcomes = await runConcurrently([
            () => claimCertificationJobForJudging(jobId, "token-a", 60_000),
            () => claimCertificationJobForJudging(jobId, "token-b", 60_000),
        ]);

        expect(rejections(outcomes)).toEqual([]);
        const winners = outcomes.filter((o) => o.ok && o.value !== null);
        expect(winners).toHaveLength(1);
        expect(await jobStatus(jobId)).toBe("judging");
    });

    it("rejects the stalled claimant's completion and failure after a reclaim, and the reclaimer completes", async () => {
        const { jobId } = await submittedJob();
        expect(await claimCertificationJobForJudging(jobId, "token-stalled", 60_000)).not.toBeNull();
        // Force the lease into the past — the claimant has stalled.
        await pgPool().query(
            "UPDATE certification_jobs SET judge_claim_expires_at = NOW() - interval '1 second' WHERE id = $1",
            [jobId]
        );

        const reclaimed = await reclaimExpiredCertificationJobs();
        expect(reclaimed.map((j) => j.id)).toContain(jobId);
        expect(await jobStatus(jobId)).toBe("submitted");

        // The stalled claimant's late writes match zero rows — verdict and failure both.
        expect(await completeCertificationJudging(jobId, "token-stalled", { judgeCompletedAt: new Date().toISOString(), judgeModel: "m", judgeResponse: {} })).toBe(false);
        expect(await failCertificationJudging(jobId, "token-stalled", "late")).toBe(false);
        expect(await jobStatus(jobId)).toBe("submitted");

        // The reclaim dispatcher's fresh claim completes normally, and the old token stays dead.
        expect(await claimCertificationJobForJudging(jobId, "token-fresh", 60_000)).not.toBeNull();
        expect(await renewCertificationJudgeLease(jobId, "token-stalled", 60_000)).toBe(false);
        expect(await renewCertificationJudgeLease(jobId, "token-fresh", 60_000)).toBe(true);
        expect(await completeCertificationJudging(jobId, "token-fresh", { judgeCompletedAt: new Date().toISOString(), judgeModel: "m", judgeResponse: {} })).toBe(true);
        expect(await jobStatus(jobId)).toBe("completed");
    });

    it("reclaims only lapsed claims, and lists only unclaimed stale submissions", async () => {
        // One agent per registration: the active-registration unique index (agent_id,
        // evaluation_id) allows only one live registration per pair.
        const agentA = await seedAgent("sweep_a");
        const agentB = await seedAgent("sweep_b");
        const agentC = await seedAgent("sweep_c");
        const agentD = await seedAgent("sweep_d");
        const lapsedReg = await seedRegistration(agentA);
        const heldReg = await seedRegistration(agentB);
        const staleReg = await seedRegistration(agentC);
        const freshReg = await seedRegistration(agentD);

        const lapsed = await seedJob({
            registrationId: lapsedReg, agentId: agentA, status: "judging",
            submittedAt: new Date(Date.now() - 20 * 60_000).toISOString(),
            judgeToken: "t-lapsed", judgeClaimExpiresAt: new Date(Date.now() - 1000).toISOString(),
        });
        const held = await seedJob({
            registrationId: heldReg, agentId: agentB, status: "judging",
            judgeToken: "t-held", judgeClaimExpiresAt: new Date(Date.now() + 60_000).toISOString(),
        });
        const stale = await seedJob({
            registrationId: staleReg, agentId: agentC, status: "submitted",
            submittedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
        });
        const fresh = await seedJob({
            registrationId: freshReg, agentId: agentD, status: "submitted",
            submittedAt: new Date().toISOString(),
        });

        const reclaimed = await reclaimExpiredCertificationJobs();
        expect(reclaimed.map((j) => j.id)).toContain(lapsed);
        expect(reclaimed.map((j) => j.id)).not.toContain(held);
        expect(await jobStatus(held)).toBe("judging");

        const staleListed = await listStaleSubmittedCertificationJobs(5 * 60_000);
        const staleIds = staleListed.map((j) => j.id);
        expect(staleIds).toContain(stale);
        expect(staleIds).toContain(lapsed); // reclaimed above: submitted, token cleared, old submitted_at
        expect(staleIds).not.toContain(fresh);
    });

    it("reclaims a leaseless legacy judging row after the grace, and leaves a recent one alone", async () => {
        // The pre-C22 judge set status='judging' with no lease before its inline model call. Such
        // a row holds the live-job unique index while being invisible to a lease-only reclaim —
        // the stranded-registration shape remedy 4 exists to prevent. After the grace (which
        // exceeds the old inline path's maximum runtime) it is reclaimed; inside it, an old
        // instance may still be mid-inference, so it is left alone.
        const agentA = await seedAgent("legacy_a");
        const agentB = await seedAgent("legacy_b");
        const abandonedReg = await seedRegistration(agentA);
        const maybeLiveReg = await seedRegistration(agentB);

        const abandoned = await seedJob({ registrationId: abandonedReg, agentId: agentA, status: "judging" });
        await pgPool().query(
            "UPDATE certification_jobs SET judge_started_at = NOW() - interval '31 minutes' WHERE id = $1",
            [abandoned]
        );
        const maybeLive = await seedJob({ registrationId: maybeLiveReg, agentId: agentB, status: "judging" });
        await pgPool().query(
            "UPDATE certification_jobs SET judge_started_at = NOW() - interval '1 minute' WHERE id = $1",
            [maybeLive]
        );

        const reclaimed = await reclaimExpiredCertificationJobs();
        const ids = reclaimed.map((j) => j.id);
        expect(ids).toContain(abandoned);
        expect(ids).not.toContain(maybeLive);
        expect(await jobStatus(abandoned)).toBe("submitted");
        expect(await jobStatus(maybeLive)).toBe("judging");
    });

    it("getLiveCertificationJobForRegistration sees live states only", async () => {
        const agent = await seedAgent("live");
        const registrationId = await seedRegistration(agent);
        await seedJob({ registrationId, agentId: agent, status: "expired" });
        expect(await getLiveCertificationJobForRegistration(registrationId)).toBeNull();

        const live = await seedJob({ registrationId, agentId: agent, status: "submitted" });
        expect((await getLiveCertificationJobForRegistration(registrationId))?.id).toBe(live);
    });
});
