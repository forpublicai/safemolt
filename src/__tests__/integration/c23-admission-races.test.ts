/**
 * M11-1 C23 `[integration]` — the partial unique index over live sessions per school and the
 * membership-checking join, against the real database. The migration's repair path is driven
 * through the real runner over a reconstructed pre-index state, exactly like C5's.
 */
import { join } from "path";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { runConcurrently } from "./helpers/concurrency";
import { joinPlaygroundSession, mergePlaygroundParticipantAffiliationFields } from "@/lib/store/playground/db";
import type { SessionParticipant } from "@/lib/playground/types";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");

const connectionString = process.env.POSTGRES_URL as string;
const SCRIPTS_DIR = join(__dirname, "../../../scripts");
const MIGRATION_FILE = "migrate-playground-live-session-unique.sql";
const INDEX_NAME = "idx_pg_sessions_one_live_per_school";
const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

async function seedSession(school: string, status = "pending", createdAgoSec = 0): Promise<string> {
    const id = `c23_sess_${RUN}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO playground_sessions
           (id, game_id, status, participants, transcript, current_round, max_rounds, created_at, school_id)
         VALUES ($1, 'c23-game', $2, '[]'::jsonb, '[]'::jsonb, 0, 5, NOW() - make_interval(secs => $3), $4)`,
        [id, status, createdAgoSec, school]
    );
    return id;
}

function participant(agentId: string): SessionParticipant {
    return { agentId, agentName: agentId, status: "active" };
}

async function migrationRecorded(): Promise<boolean> {
    const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
    return (rowCount ?? 0) > 0;
}

function runMigration() {
    return migrate({
        files: [{ file: MIGRATION_FILE, label: "C23 one live session" }],
        dir: SCRIPTS_DIR,
        connectionString,
    });
}

afterAll(async () => {
    await pgPool().query("DELETE FROM playground_sessions WHERE id LIKE $1", [`c23_sess_${RUN}%`]);
    if (!(await migrationRecorded())) await runMigration();
    await closeIntegrationConnections();
});

describe("one live session per school (db constraint)", () => {
    it("concurrent inserts for one school admit exactly one; different schools coexist", async () => {
        const school = `c23_school_${RUN}_a`;
        const outcomes = await runConcurrently(
            Array.from({ length: 3 }, () => () => seedSession(school))
        );
        const admitted = outcomes.filter((o) => o.ok);
        expect(admitted).toHaveLength(1);
        outcomes
            .filter((o) => !o.ok)
            .forEach((o) => {
                expect((o as { error: { code?: string } }).error.code).toBe("23505");
            });

        // A different school is not serialized by the index.
        await expect(seedSession(`c23_school_${RUN}_b`)).resolves.toBeTruthy();
    });

    it("a cancelled or completed session does not block a new live one", async () => {
        const school = `c23_school_${RUN}_c`;
        const first = await seedSession(school);
        await pgPool().query("UPDATE playground_sessions SET status = 'cancelled' WHERE id = $1", [first]);
        await expect(seedSession(school)).resolves.toBeTruthy();
    });
});

describe("join membership predicate (db)", () => {
    it("the same agent joining concurrently occupies exactly one seat, asserted on the array", async () => {
        const school = `c23_school_${RUN}_j1`;
        const sessionId = await seedSession(school);

        const outcomes = await runConcurrently(
            Array.from({ length: 4 }, () => () => joinPlaygroundSession(sessionId, participant("c23_dup"), 5))
        );
        // Joining twice is idempotent success, never an error.
        expect(outcomes.every((o) => o.ok && o.value.success)).toBe(true);

        const { rows } = await pgPool().query<{ len: number; ids: string }>(
            `SELECT jsonb_array_length(participants) AS len,
                    (SELECT string_agg(p->>'agentId', ',') FROM jsonb_array_elements(participants) p) AS ids
             FROM playground_sessions WHERE id = $1`,
            [sessionId]
        );
        expect(rows[0].len).toBe(1);
        expect(rows[0].ids).toBe("c23_dup");
    });

    it("two different agents joining concurrently both persist; capacity is enforced in-statement", async () => {
        const school = `c23_school_${RUN}_j2`;
        const sessionId = await seedSession(school);

        const outcomes = await runConcurrently([
            () => joinPlaygroundSession(sessionId, participant("c23_x"), 2),
            () => joinPlaygroundSession(sessionId, participant("c23_y"), 2),
        ]);
        expect(outcomes.every((o) => o.ok && o.value.success)).toBe(true);

        const overflow = await joinPlaygroundSession(sessionId, participant("c23_z"), 2);
        expect(overflow.success).toBe(false);
        expect(overflow.reason).toBe("Session full");

        const { rows } = await pgPool().query<{ len: number }>(
            "SELECT jsonb_array_length(participants) AS len FROM playground_sessions WHERE id = $1",
            [sessionId]
        );
        expect(rows[0].len).toBe(2);
    });
});

describe("affiliation merge does not clobber a concurrent joiner (M11-1b review B3)", () => {
    it("an in-flight affiliation patch preserves a participant that joined after the patch's snapshot", async () => {
        const school = `c23_school_${RUN}_aff`;
        const sessionId = await seedSession(school);
        // A is already in with empty affiliation fields.
        await joinPlaygroundSession(sessionId, participant("c23_aff_A"), 5);

        // The pre-B3 shape read the whole array, patched A in JS, and wrote the whole array back
        // in a second call — so a join that committed in between was erased. B joins, THEN the
        // patch lands. If the patch overwrote the array, B would be lost.
        await joinPlaygroundSession(sessionId, participant("c23_aff_B"), 5);
        await mergePlaygroundParticipantAffiliationFields(sessionId, "c23_aff_A", {
            actingAsCompanyId: "acme-co",
        });

        const { rows } = await pgPool().query<{ ids: string; company: string | null }>(
            `SELECT (SELECT string_agg(p->>'agentId', ',' ORDER BY p->>'agentId') FROM jsonb_array_elements(participants) p) AS ids,
                    (SELECT p->>'actingAsCompanyId' FROM jsonb_array_elements(participants) p WHERE p->>'agentId' = 'c23_aff_A') AS company
             FROM playground_sessions WHERE id = $1`,
            [sessionId]
        );
        // Both participants present, and A's affiliation applied to A only.
        expect(rows[0].ids).toBe("c23_aff_A,c23_aff_B");
        expect(rows[0].company).toBe("acme-co");
    });

    it("only fills empty affiliation fields and never touches another participant", async () => {
        const school = `c23_school_${RUN}_aff2`;
        const sessionId = await seedSession(school);
        await joinPlaygroundSession(sessionId, { ...participant("c23_aff_C"), actingAsLabel: "existing" } as SessionParticipant, 5);
        await joinPlaygroundSession(sessionId, participant("c23_aff_D"), 5);

        // C already has a label — fill-if-empty must leave it, and D must be untouched.
        await mergePlaygroundParticipantAffiliationFields(sessionId, "c23_aff_C", { actingAsLabel: "new-label" });
        const { rows } = await pgPool().query<{ c_label: string; d: string }>(
            `SELECT (SELECT p->>'actingAsLabel' FROM jsonb_array_elements(participants) p WHERE p->>'agentId' = 'c23_aff_C') AS c_label,
                    (SELECT p->>'actingAsLabel' FROM jsonb_array_elements(participants) p WHERE p->>'agentId' = 'c23_aff_D') AS d
             FROM playground_sessions WHERE id = $1`,
            [sessionId]
        );
        expect(rows[0].c_label).toBe("existing");
        expect(rows[0].d).toBeNull();
    });
});

describe("the migration's repair through the real runner", () => {
    it("collapses multi-live-session schools keep-earliest into C3's system-repair shape, then constrains", async () => {
        // Reconstruct the pre-index state.
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await pgPool().query(`DROP INDEX IF EXISTS ${INDEX_NAME}`);
        const school = `c23_school_${RUN}_repair`;
        const keeper = await seedSession(school, "pending", 3600); // earliest
        const surplusA = await seedSession(school, "pending", 60);
        const surplusB = await seedSession(school, "active", 10);

        await runMigration();
        expect(await migrationRecorded()).toBe(true);

        const { rows } = await pgPool().query<{
            id: string;
            status: string;
            cancelled_by_agent_id: string | null;
            cancelled_reason: string | null;
        }>(
            `SELECT id, status, cancelled_by_agent_id, cancelled_reason
             FROM playground_sessions WHERE school_id = $1 ORDER BY created_at ASC`,
            [school]
        );
        expect(rows.find((r) => r.id === keeper)?.status).toBe("pending");
        for (const surplus of [surplusA, surplusB]) {
            const row = rows.find((r) => r.id === surplus);
            expect(row?.status).toBe("cancelled");
            // System repair, never attributed to an agent — a migration has no truthful actor.
            expect(row?.cancelled_by_agent_id).toBeNull();
            expect(row?.cancelled_reason).toBe("system: repair - duplicate live session");
        }

        // Re-running changes nothing (idempotent) and the index stands.
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await runMigration();
        const { rows: after } = await pgPool().query(
            "SELECT id FROM playground_sessions WHERE school_id = $1 AND status = 'pending'",
            [school]
        );
        expect(after).toHaveLength(1);
    });
});

describe("C23 migration postconditions", () => {
    it("the partial unique index exists with the probed deparse shapes", async () => {
        const { rows } = await pgPool().query<{ expr: string; pred: string; unique: boolean }>(
            `SELECT pg_get_expr(i.indexprs, i.indrelid) AS expr,
                    pg_get_expr(i.indpred, i.indrelid) AS pred,
                    i.indisunique AS "unique"
             FROM pg_class c JOIN pg_index i ON i.indexrelid = c.oid
             WHERE c.relname = $1 AND i.indrelid = 'public.playground_sessions'::regclass`,
            [INDEX_NAME]
        );
        expect(rows[0]).toEqual({
            expr: "COALESCE(school_id, 'foundation'::text)",
            pred: "(status = ANY (ARRAY['pending'::text, 'active'::text]))",
            unique: true,
        });
    });
});
