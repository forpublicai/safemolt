/**
 * M11-1 C2 `[integration]` — the parts of the evaluation surface a mocked `sql` cannot show.
 *
 * Three of them, and each is a claim the chunk makes rather than a mechanism it merely uses:
 *
 *  1. **The claim is all-or-nothing.** It used to be a read, a session insert, and two independently
 *     auto-committed participant inserts. A crash between them stranded a session with an empty
 *     roster — which is the authoritative record of who may submit — so the registration became
 *     unsubmittable *and* unclaimable. Proving the fix means observing that no committable state has
 *     a session without both participants, and that a second claimant blocks on the first rather
 *     than checking-then-inserting.
 *  2. **Transcript numbering is serialized.** `MAX(sequence) + 1` with no lock hands two concurrent
 *     senders the same number. This is snapshot behaviour: it cannot be observed against a mock, and
 *     it cannot be fixed by folding the lock into the insert as a CTE, because one statement gets
 *     one snapshot.
 *  3. **Authorization never joins `evaluation_definitions`.** Two schools ship
 *     `twitter-verification` and sync upserts by a bare global id, so that table holds whichever
 *     school synced last. The fixture below syncs **Foundation last** on purpose: an implementation
 *     that resolved the school by joining would authorize a Humanities registration against
 *     Foundation's row and pass this test's negative case.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { raceAgainstHeldLock, rejections, runConcurrently } from "./helpers/concurrency";
import { addSessionMessage, claimProctorSession } from "@/lib/store/evaluations/db";
import { authorizeProctorClaim } from "@/lib/evaluation-authz";
import type { StoredAgent } from "@/lib/store-types";

const PREFIX = "c2_";
/** Foundation-only and genuinely proctored (`schools/foundation/evaluations/SIP-5.md`). */
const PROCTORED = "non-spamminess";
/** Shipped by Foundation *and* Humanities — the id whose school a join cannot answer. */
const AMBIGUOUS = "twitter-verification";

let seq = 0;

function agentFixture(id: string, overrides: Partial<StoredAgent> = {}): StoredAgent {
    return {
        id,
        name: id,
        description: "",
        apiKey: `${PREFIX}key_${id}`,
        points: 0,
        votePoints: 0,
        evaluationPoints: 0,
        legacyUnattributedPoints: 0,
        followerCount: 0,
        isClaimed: false,
        createdAt: new Date().toISOString(),
        isVetted: true,
        isAdmitted: true,
        ...overrides,
    };
}

async function seedAgent(suffix: string): Promise<string> {
    const id = `${PREFIX}agent_${suffix}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at)
         VALUES ($1, $1, '', $2, 0, 0, false, NOW())`,
        [id, `${PREFIX}key_${id}`]
    );
    return id;
}

async function seedDefinition(evaluationId: string, type: string): Promise<void> {
    await pgPool().query(
        `INSERT INTO evaluation_definitions
           (id, sip_number, name, module, type, status, file_path, executable_handler, executable_script_path, version, created_at, updated_at)
         VALUES ($1, $2, $1, 'core', $3, 'active', 'x', 'x', 'x', '1.0.0', NOW(), NOW())
         ON CONFLICT (id) DO UPDATE SET type = EXCLUDED.type`,
        [evaluationId, 9000 + (seq += 1), type]
    );
}

async function seedRegistration(opts: {
    agentId: string;
    evaluationId: string;
    schoolId?: string;
    schoolScopeTrusted?: boolean;
}): Promise<string> {
    const id = `${PREFIX}reg_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO evaluation_registrations
           (id, agent_id, evaluation_id, registered_at, status, school_id, school_scope_trusted)
         VALUES ($1, $2, $3, NOW(), 'in_progress', $4, $5)`,
        [id, opts.agentId, opts.evaluationId, opts.schoolId ?? "foundation", opts.schoolScopeTrusted ?? false]
    );
    return id;
}

async function rosterOf(sessionId: string): Promise<string[]> {
    const { rows } = await pgPool().query<{ agent_id: string; role: string }>(
        "SELECT agent_id, role FROM evaluation_session_participants WHERE session_id = $1 ORDER BY role",
        [sessionId]
    );
    return rows.map((r) => `${r.role}`);
}

async function sessionCount(registrationId: string): Promise<number> {
    const { rows } = await pgPool().query<{ n: string }>(
        "SELECT count(*) AS n FROM evaluation_sessions WHERE registration_id = $1",
        [registrationId]
    );
    return Number(rows[0].n);
}

async function cleanUp(): Promise<void> {
    await pgPool().query("DELETE FROM evaluation_messages WHERE session_id LIKE $1", [`${PREFIX}%`]);
    await pgPool().query("DELETE FROM evaluation_session_participants WHERE session_id IN (SELECT id FROM evaluation_sessions WHERE registration_id LIKE $1)", [`${PREFIX}%`]);
    await pgPool().query("DELETE FROM evaluation_sessions WHERE registration_id LIKE $1", [`${PREFIX}%`]);
    await pgPool().query("DELETE FROM evaluation_results WHERE registration_id LIKE $1", [`${PREFIX}%`]);
    await pgPool().query("DELETE FROM evaluation_registrations WHERE id LIKE $1", [`${PREFIX}%`]);
    await pgPool().query("DELETE FROM agents WHERE id LIKE $1", [`${PREFIX}%`]);
}

beforeAll(async () => {
    await seedDefinition(PROCTORED, "proctored");
    await seedDefinition(AMBIGUOUS, "simple_pass_fail");
});

beforeEach(cleanUp);

afterAll(async () => {
    await cleanUp();
    await closeIntegrationConnections();
});

describe("claiming a proctor session", () => {
    it("commits the session and both participants together", async () => {
        const candidate = await seedAgent("cand");
        const proctor = await seedAgent("proc");
        const registrationId = await seedRegistration({ agentId: candidate, evaluationId: PROCTORED });

        const sessionId = await claimProctorSession(registrationId, proctor);
        expect(sessionId).not.toBeNull();
        expect(await rosterOf(sessionId!)).toEqual(["candidate", "proctor"]);
    });

    it("admits exactly one of two concurrent claimants and writes one roster", async () => {
        const candidate = await seedAgent("cand");
        const first = await seedAgent("proc_a");
        const second = await seedAgent("proc_b");
        const registrationId = await seedRegistration({ agentId: candidate, evaluationId: PROCTORED });

        const outcomes = await runConcurrently([
            () => claimProctorSession(registrationId, first),
            () => claimProctorSession(registrationId, second),
        ]);

        expect(rejections(outcomes)).toEqual([]);
        const winners = outcomes.filter((o) => o.ok && o.value !== null);
        expect(winners).toHaveLength(1);
        expect(await sessionCount(registrationId)).toBe(1);

        const sessionId = (winners[0] as { value: string }).value;
        expect(await rosterOf(sessionId)).toEqual(["candidate", "proctor"]);
    });

    it("blocks on the registration row rather than checking and inserting anyway", async () => {
        const candidate = await seedAgent("cand");
        const proctor = await seedAgent("proc");
        const registrationId = await seedRegistration({ agentId: candidate, evaluationId: PROCTORED });

        const observation = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query(
                    "UPDATE evaluation_registrations SET status = 'in_progress' WHERE id = $1",
                    [registrationId]
                );
            },
            contend: () => claimProctorSession(registrationId, proctor),
            // The marker must name the statement that *blocks*, which is the batch's `FOR UPDATE`
            // element and not the CTE that follows it: `pg_stat_activity.query` reports whichever
            // statement of the batch the backend is currently executing. Marking the CTE would
            // observe no waiter and report a race the harness never actually saw.
            contenderMarker: "race:c2-proctor-claim",
        });

        expect(observation.observedBlocked).toBe(true);
        expect(observation.result).not.toBeNull();
        expect(await rosterOf(observation.result!)).toEqual(["candidate", "proctor"]);
    });

    /**
     * The named failure-injection gate: **no committable state has a session without its
     * participants.**
     *
     * The injection is a real constraint, not a stub. `evaluation_session_participants.agent_id`
     * references `agents(id)`, so claiming for a proctor that does not exist raises 23503 on the
     * participant arm — which, under the pre-C2 shape (session insert, then two independently
     * auto-committed participant inserts), arrived *after* the session had already committed. That
     * stranded session was both unsubmittable and unclaimable, because the roster it authorizes
     * against was empty and a session already existed.
     */
    it("commits nothing when the participant write fails, and stays claimable afterwards", async () => {
        const candidate = await seedAgent("cand");
        const registrationId = await seedRegistration({ agentId: candidate, evaluationId: PROCTORED });

        await expect(claimProctorSession(registrationId, `${PREFIX}proctor_who_does_not_exist`)).rejects.toMatchObject({
            code: "23503",
        });

        expect(await sessionCount(registrationId)).toBe(0);
        const { rows } = await pgPool().query(
            "SELECT 1 FROM evaluation_session_participants WHERE session_id IN (SELECT id FROM evaluation_sessions WHERE registration_id = $1)",
            [registrationId]
        );
        expect(rows).toHaveLength(0);

        // The lockout is gone with it: a real proctor can still claim.
        const realProctor = await seedAgent("proc");
        const sessionId = await claimProctorSession(registrationId, realProctor);
        expect(sessionId).not.toBeNull();
        expect(await rosterOf(sessionId!)).toEqual(["candidate", "proctor"]);
    });

    it("refuses a registration that already has a session, without a second roster", async () => {
        const candidate = await seedAgent("cand");
        const first = await seedAgent("proc_a");
        const second = await seedAgent("proc_b");
        const registrationId = await seedRegistration({ agentId: candidate, evaluationId: PROCTORED });

        expect(await claimProctorSession(registrationId, first)).not.toBeNull();
        expect(await claimProctorSession(registrationId, second)).toBeNull();
        expect(await sessionCount(registrationId)).toBe(1);
    });
});

describe("transcript numbering", () => {
    async function seedSession(): Promise<{ sessionId: string; candidate: string; proctor: string }> {
        const candidate = await seedAgent("cand");
        const proctor = await seedAgent("proc");
        const registrationId = await seedRegistration({ agentId: candidate, evaluationId: PROCTORED });
        const sessionId = await claimProctorSession(registrationId, proctor);
        return { sessionId: sessionId!, candidate, proctor };
    }

    it("gives two concurrent senders distinct, consecutive sequence numbers", async () => {
        const { sessionId, candidate, proctor } = await seedSession();

        const outcomes = await runConcurrently([
            () => addSessionMessage(sessionId, candidate, "candidate", "from the candidate"),
            () => addSessionMessage(sessionId, proctor, "proctor", "from the proctor"),
        ]);

        expect(rejections(outcomes)).toEqual([]);
        const sequences = outcomes
            .map((o) => (o.ok ? (o.value as { sequence: number }).sequence : -1))
            .sort((a, b) => a - b);
        expect(sequences).toEqual([1, 2]);

        // And the transcript order is deterministic rather than merely non-colliding.
        const { rows } = await pgPool().query<{ sequence: number }>(
            "SELECT sequence FROM evaluation_messages WHERE session_id = $1 ORDER BY sequence",
            [sessionId]
        );
        expect(rows.map((r) => r.sequence)).toEqual([1, 2]);
    });

    /**
     * **The discriminating gate, and the first attempt at it was not one.**
     *
     * The obvious shape — hold `SELECT … FOR UPDATE` on the session, race an insert — goes green
     * with the fix reverted, and it took actually reverting it to find that out. The reason is the
     * foreign key: `evaluation_messages.session_id` references the session, so *any* insert takes
     * `FOR KEY SHARE` on that row and blocks behind a `FOR UPDATE` holder whether or not the store
     * asked for a lock. The test observed contention that the production statement did not cause.
     *
     * So the holder here is the thing actually being defended against: **another sender, mid-flight
     * and uncommitted**. Two inserts each hold `FOR KEY SHARE`, which are compatible — so an
     * unlocked implementation does not block, computes `MAX(sequence) + 1` against a snapshot that
     * cannot see the in-flight row, and produces sequence 1 twice. The fix's explicit `FOR UPDATE`
     * conflicts with the holder's `FOR KEY SHARE`, waits, and re-reads under a fresh snapshot.
     *
     * Reverted, this fails twice over: `observedBlocked` is false, and the duplicate insert is
     * refused by the unique index, which `raceAgainstHeldLock` rethrows.
     */
    it("waits for an in-flight sender instead of numbering against a stale snapshot", async () => {
        const { sessionId, candidate, proctor } = await seedSession();

        const observation = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query(
                    `INSERT INTO evaluation_messages (id, session_id, sender_agent_id, role, content, created_at, sequence)
                     SELECT $1, $2, $3, 'proctor', 'in flight', NOW(),
                       COALESCE((SELECT MAX(sequence) + 1 FROM evaluation_messages WHERE session_id = $2), 1)`,
                    [`${PREFIX}msg_inflight`, sessionId, proctor]
                );
            },
            contend: () => addSessionMessage(sessionId, candidate, "candidate", "second"),
            contenderMarker: "race:c2-message-sequence",
        });

        expect(observation.observedBlocked).toBe(true);
        expect(observation.result).not.toBeNull();
        expect(observation.result!.sequence).toBe(2);
    });

    it("carries a unique (session_id, sequence) index that refuses a collision outright", async () => {
        const { sessionId, candidate } = await seedSession();
        await addSessionMessage(sessionId, candidate, "candidate", "first");

        await expect(
            pgPool().query(
                `INSERT INTO evaluation_messages (id, session_id, sender_agent_id, role, content, created_at, sequence)
                 VALUES ($1, $2, $3, 'candidate', 'forged', NOW(), 1)`,
                [`${PREFIX}msg_forged`, sessionId, candidate]
            )
        ).rejects.toMatchObject({ code: "23505" });
    });
});

describe("the collision repair in the migration", () => {
    const migrationSql = readFileSync(
        join(process.cwd(), "scripts", "migrate-evaluation-school-provenance.sql"),
        "utf8"
    );

    it("resequences a colliding transcript deterministically, and re-running changes nothing", async () => {
        const candidate = await seedAgent("cand");
        const proctor = await seedAgent("proc");
        const registrationId = await seedRegistration({ agentId: candidate, evaluationId: PROCTORED });
        const sessionId = (await claimProctorSession(registrationId, proctor))!;

        // The collision the unique index now forbids, seeded the only way it can be: with the index
        // out of the way, exactly as the pre-migration table looked.
        await pgPool().query("DROP INDEX IF EXISTS idx_eval_messages_session_seq_uniq");
        for (const [n, sequence] of [[1, 1], [2, 1], [3, 2]] as const) {
            await pgPool().query(
                `INSERT INTO evaluation_messages (id, session_id, sender_agent_id, role, content, created_at, sequence)
                 VALUES ($1, $2, $3, 'candidate', $4, NOW() + ($5 || ' seconds')::interval, $6)`,
                [`${PREFIX}msg_${n}`, sessionId, candidate, `m${n}`, n, sequence]
            );
        }

        await pgPool().query(migrationSql);
        const afterFirst = await pgPool().query<{ id: string; sequence: number }>(
            "SELECT id, sequence FROM evaluation_messages WHERE session_id = $1 ORDER BY sequence",
            [sessionId]
        );
        expect(afterFirst.rows.map((r) => r.sequence)).toEqual([1, 2, 3]);

        await pgPool().query(migrationSql);
        const afterSecond = await pgPool().query<{ id: string; sequence: number }>(
            "SELECT id, sequence FROM evaluation_messages WHERE session_id = $1 ORDER BY sequence",
            [sessionId]
        );
        expect(afterSecond.rows).toEqual(afterFirst.rows);
    });

    /**
     * The guard's whole reason for reading `pg_index` instead of `pg_get_indexdef`.
     *
     * A same-named **partial** unique index renders as `CREATE UNIQUE INDEX … (session_id, sequence)
     * WHERE …`, which satisfies any regex looking for that prefix — and `CREATE … IF NOT EXISTS`
     * then skips creating the real one, so the migration would record success while transcripts
     * stayed unconstrained outside the predicate. Raised, not skipped: a partial deployment is a
     * state an operator has to see.
     */
    it("refuses a same-named index of the wrong shape instead of skipping past it", async () => {
        await pgPool().query("DROP INDEX IF EXISTS idx_eval_messages_session_seq_uniq");
        await pgPool().query(
            `CREATE UNIQUE INDEX idx_eval_messages_session_seq_uniq
             ON evaluation_messages (session_id, sequence) WHERE role = 'proctor'`
        );

        await expect(pgPool().query(migrationSql)).rejects.toThrow(/wrong shape/);

        // And the recovery path the message names actually works.
        await pgPool().query("DROP INDEX IF EXISTS idx_eval_messages_session_seq_uniq");
        await expect(pgPool().query(migrationSql)).resolves.toBeDefined();
    });
});

describe("authorization does not resolve the school by joining evaluation_definitions", () => {
    it("authorizes a trusted Humanities registration against Humanities while the table holds Foundation's row", async () => {
        // Foundation synced last: `evaluation_definitions` now describes Foundation's
        // `twitter-verification`, which is the only row a join could find.
        await seedDefinition(AMBIGUOUS, "simple_pass_fail");

        const candidate = await seedAgent("cand");
        const registrationId = await seedRegistration({
            agentId: candidate,
            evaluationId: AMBIGUOUS,
            schoolId: "humanities",
            schoolScopeTrusted: true,
        });

        // Vetted but not admitted: fine in Foundation, refused in Humanities. A join-based
        // implementation reads Foundation's row and lets this through.
        const proctor = agentFixture("c2_proctor_vetted_only", { isVetted: true, isAdmitted: false });
        const decision = await authorizeProctorClaim({ agent: proctor, registrationId });

        expect(decision.ok).toBe(false);
        expect(decision.ok === false && decision.denial.code).toBe("admission_required");
    });

    /**
     * The mirror case, with the sync order reversed.
     *
     * The gate above syncs Foundation last, so a join-based implementation would read Foundation's
     * row. This one syncs a *Humanities-shaped* row last for the same id — a join now reads
     * Humanities — and authorizes a **Foundation** registration. An implementation that resolved the
     * school from `evaluation_definitions` fails one of these two whichever way it leans; only one
     * that never consults the table passes both.
     */
    it("authorizes a trusted Foundation registration against Foundation while the table holds the other school's row", async () => {
        await pgPool().query(
            `UPDATE evaluation_definitions SET name = 'Humanities sign-in verification', updated_at = NOW() WHERE id = $1`,
            [AMBIGUOUS]
        );

        const candidate = await seedAgent("cand");
        const registrationId = await seedRegistration({
            agentId: candidate,
            evaluationId: AMBIGUOUS,
            schoolId: "foundation",
            schoolScopeTrusted: true,
        });

        // Vetted but not admitted: refused in Humanities, fine in Foundation. Resolving through the
        // table would deny this legitimate claim attempt on the wrong school's rule.
        const proctor = agentFixture("c2_proctor_vetted_only_2", { isVetted: true, isAdmitted: false });
        const decision = await authorizeProctorClaim({ agent: proctor, registrationId });

        expect(decision.ok).toBe(false);
        // Not `admission_required` — Foundation was resolved, so the rule that applies is vetting,
        // which this agent satisfies; the refusal is the evaluation simply not being proctored.
        expect(decision.ok === false && decision.denial.code).toBe("not_proctored");
    });

    it("refuses an untrusted registration whose id more than one school defines", async () => {
        const candidate = await seedAgent("cand");
        const registrationId = await seedRegistration({
            agentId: candidate,
            evaluationId: AMBIGUOUS,
            schoolScopeTrusted: false,
        });

        const decision = await authorizeProctorClaim({
            agent: agentFixture("c2_proctor_any"),
            registrationId,
        });

        expect(decision.ok).toBe(false);
        expect(decision.ok === false && decision.denial.code).toBe("ambiguous_registration_school");
    });
});
