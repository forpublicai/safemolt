/**
 * M11-1 C12 `[integration]` — the leased per-(session, round) resolution claim and the gated
 * action insert, against the real database.
 *
 * The GM engine is mocked (these gates count invocations — a real HF call would make cost the
 * test's own subject), but every claim, fence, and insert below runs the production SQL. The
 * lease guarantees at-most-one COMMIT per round and once-in-the-common-case billing; the overlap
 * test additionally asserts the residual the plan refuses to paper over: a stalled claimant's
 * spend is not un-spent by the fence.
 */

jest.mock("@/lib/playground/engine", () => ({
    generateRoundPrompt: jest.fn(async () => "next prompt"),
    resolveRound: jest.fn(async () => ({ narration: "GM narration", isGameOver: false })),
    generateSummary: jest.fn(async () => "summary"),
}));

jest.mock("@/lib/memory/platform-ingest", () => ({
    schedulePlaygroundMemoryIngest: jest.fn(),
}));

jest.mock("@/lib/playground/memory", () => ({
    storeMemory: jest.fn(async () => ({})),
    // M11-1b D5: derived writes are gated on the winning claim. Returning true keeps this suite's
    // subject the RESOLUTION fence rather than the memory fence — the memory fence has its own
    // gates in `d5-playground-memories.test.ts`.
    storeMemoryFenced: jest.fn(async () => true),
    getAllSessionMemories: jest.fn(async () => []),
}));

jest.mock("@/lib/playground/embeddings", () => ({
    getEmbedding: jest.fn(async () => undefined),
}));

jest.mock("@/lib/playground/games", () => ({
    pickRandomGame: jest.fn(),
    getSchoolGameById: jest.fn(() => ({
        id: "c12-game",
        name: "C12 Game",
        minPlayers: 1,
        maxPlayers: 4,
        premise: "",
        rules: "",
        scenes: [],
    })),
    listSchoolGameDefs: jest.fn(() => []),
    listGames: jest.fn(() => []),
}));

import { join } from "path";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { runConcurrently } from "./helpers/concurrency";
import { tryAdvanceRound } from "@/lib/playground/session-manager";
import {
    applyPlaygroundResolution,
    claimPlaygroundResolution,
    submitPlaygroundActionGated,
} from "@/lib/store/playground/db";
import { resolveRound } from "@/lib/playground/engine";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");
const C12_SCRIPTS_DIR = join(__dirname, "../../../scripts");
const C12_MIGRATION_FILE = "migrate-playground-resolution-claim.sql";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

interface SeedOptions {
    participants?: string[];
    round?: number;
    deadlinePassed?: boolean;
    claim?: { token: string; expiresInMs: number };
}

async function seedSession(options: SeedOptions = {}): Promise<string> {
    const id = `c12_sess_${RUN}_${(seq += 1)}`;
    const participants = (options.participants ?? ["p1"]).map((agentId) => ({
        agentId,
        agentName: agentId,
        status: "active",
        missedRounds: 0,
    }));
    await pgPool().query(
        `INSERT INTO playground_sessions
           (id, game_id, status, participants, transcript, current_round, current_round_prompt,
            round_deadline, max_rounds, created_at, started_at, school_id,
            resolve_claim_token, resolve_claim_expires_at)
         VALUES ($1, 'c12-game', 'active', $2::jsonb, '[]'::jsonb, $3, 'prompt',
                 NOW() + make_interval(secs => $4), 5, NOW(), NOW(), $1,
                 $5::text, CASE WHEN $5::text IS NULL THEN NULL ELSE NOW() + make_interval(secs => $6) END)`,
        [
            id,
            JSON.stringify(participants),
            options.round ?? 1,
            options.deadlinePassed === false ? 3600 : -60,
            options.claim?.token ?? null,
            (options.claim?.expiresInMs ?? 0) / 1000,
        ]
    );
    return id;
}

async function seedAction(sessionId: string, agentId: string, round: number): Promise<void> {
    await pgPool().query(
        `INSERT INTO playground_actions (id, session_id, agent_id, round, content, created_at)
         VALUES ($1, $2, $3, $4, 'seeded action', NOW())`,
        [`c12_act_${RUN}_${(seq += 1)}`, sessionId, agentId, round]
    );
}

async function sessionRow(id: string) {
    const { rows } = await pgPool().query<{
        status: string;
        current_round: number;
        transcript: Array<{ round: number }>;
        resolve_claim_token: string | null;
    }>("SELECT status, current_round, transcript, resolve_claim_token FROM playground_sessions WHERE id = $1", [id]);
    return rows[0];
}

afterAll(async () => {
    await pgPool().query("DELETE FROM activity_events WHERE entity_id LIKE $1", [`c12_%${RUN}%`]);
    await pgPool().query("DELETE FROM playground_sessions WHERE id LIKE $1", [`c12_sess_${RUN}%`]);
    await closeIntegrationConnections();
});

beforeEach(() => {
    jest.mocked(resolveRound).mockClear();
    jest.mocked(resolveRound).mockImplementation(async () => ({ narration: "GM narration", isGameOver: false }));
});

describe("cross-instance deadline resolution", () => {
    it("concurrent tryAdvanceRound calls invoke the GM exactly once and advance exactly once", async () => {
        const sessionId = await seedSession({ participants: ["p1"], deadlinePassed: true });
        await seedAction(sessionId, "p1", 1);

        await runConcurrently([
            () => tryAdvanceRound(sessionId),
            () => tryAdvanceRound(sessionId),
            () => tryAdvanceRound(sessionId),
        ]);

        expect(jest.mocked(resolveRound)).toHaveBeenCalledTimes(1);
        const row = await sessionRow(sessionId);
        expect(row.current_round).toBe(2);
        expect(row.transcript).toHaveLength(1);
        expect(row.resolve_claim_token).toBeNull();
    });
});

describe("expired-lease reclaim", () => {
    it("a lapsed claim is reclaimable and the reclaimer completes the round", async () => {
        const sessionId = await seedSession({
            participants: ["p1"],
            deadlinePassed: true,
            claim: { token: "dead_claimant", expiresInMs: -60_000 },
        });
        await seedAction(sessionId, "p1", 1);

        await tryAdvanceRound(sessionId);

        expect(jest.mocked(resolveRound)).toHaveBeenCalledTimes(1);
        const row = await sessionRow(sessionId);
        expect(row.current_round).toBe(2);
        // The dead claimant's late terminal write is fenced out.
        expect(
            await applyPlaygroundResolution(sessionId, { round: 1, token: "dead_claimant" }, { currentRound: 99 })
        ).toBe(false);
        expect((await sessionRow(sessionId)).current_round).toBe(2);
    });
});

describe("the overlap the two gates above cannot replace", () => {
    it("a claimant stalled past its lease: exactly one COMMIT, but TWO GM invocations — the residual, asserted", async () => {
        const sessionId = await seedSession({ participants: ["p1"], deadlinePassed: true });
        await seedAction(sessionId, "p1", 1);

        // Claimant A takes the lease and starts inference, then wedges: its renewal never runs.
        // A's inference is driven directly here (a wedged process runs nothing), but its terminal
        // write below goes through the production fence — which is the assertion that matters.
        expect(await claimPlaygroundResolution(sessionId, 1, "stalled_A", 1_000)).toBe(true);
        let releaseA: (v: { narration: string; isGameOver: boolean }) => void;
        const aInference = new Promise<{ narration: string; isGameOver: boolean }>((resolve) => {
            releaseA = resolve;
        });
        jest.mocked(resolveRound).mockImplementationOnce(async () => aInference);
        const aCall = resolveRound(null as never, null as never, [] as never); // A's billed call, in flight

        // A's lease lapses; B reclaims and resolves normally.
        await new Promise((resolve) => setTimeout(resolve, 1_200));
        await tryAdvanceRound(sessionId);

        // A's inference finally returns; its write is fenced out.
        releaseA!({ narration: "A's late narration", isGameOver: false });
        await aCall;
        expect(
            await applyPlaygroundResolution(sessionId, { round: 1, token: "stalled_A" }, { currentRound: 99 })
        ).toBe(false);

        // The guarantee: one commit. The residual: two invocations. Both stated, neither hidden.
        expect(jest.mocked(resolveRound)).toHaveBeenCalledTimes(2);
        const row = await sessionRow(sessionId);
        expect(row.current_round).toBe(2);
        expect(row.transcript).toHaveLength(1);
        expect(row.transcript[0]).toEqual(expect.objectContaining({ gmResolution: "GM narration" }));
    });
});

describe("lapsed-lease loser cannot commit a stale transcript (M11-1b review B2)", () => {
    it("a resolver whose lease lapsed while an action landed is fenced out; a reclaimer keeps the action", async () => {
        const sessionId = await seedSession({ participants: ["p1", "p2"], deadlinePassed: false });

        // A claims round 1, reads NO actions yet (its transcript is empty), then its lease lapses.
        // Set the expiry into the past directly: the store's renew floors the interval at 1s, so
        // it cannot express a lapse, and a real sleep would be flaky at that minimum.
        expect(await claimPlaygroundResolution(sessionId, 1, "stale_A", 60_000)).toBe(true);
        await pgPool().query(
            "UPDATE playground_sessions SET resolve_claim_expires_at = NOW() - interval '1 minute' WHERE id = $1",
            [sessionId]
        );

        // With the lease lapsed, p1's action is admitted (the gated insert allows a lapsed claim).
        const admitted = await submitPlaygroundActionGated({
            id: `c12_lapse_${RUN}`,
            sessionId,
            agentId: "p1",
            round: 1,
            content: "landed after A's lease died",
        });
        expect(admitted.ok).toBe(true);

        // A returns and tries to commit its pre-action transcript. Before B2 this succeeded (token,
        // round, status all still matched) and silently dropped p1's action. Now the lease-liveness
        // clause in the fence rejects it.
        const aWrite = await applyPlaygroundResolution(sessionId, { round: 1, token: "stale_A" }, {
            currentRound: 2,
            currentRoundPrompt: "A's stale round 2",
            transcript: [{ round: 1, gmPrompt: "p", actions: [], gmResolution: "A saw nothing", resolvedAt: new Date().toISOString() }],
        });
        expect(aWrite).toBe(false);

        // The round is still on 1 and p1's action survives for a reclaimer.
        const row = await sessionRow(sessionId);
        expect(row.current_round).toBe(1);
        const { rows } = await pgPool().query(
            "SELECT content FROM playground_actions WHERE session_id = $1 AND round = 1 AND agent_id = 'p1'",
            [sessionId]
        );
        expect(rows[0]?.content).toBe("landed after A's lease died");
    });
});

describe("action-vs-advance (db)", () => {
    it("a claimed round refuses actions; an advanced round refuses them as stale; the transcript never silently drops one", async () => {
        const sessionId = await seedSession({ participants: ["p1", "p2"], deadlinePassed: false });
        expect(await claimPlaygroundResolution(sessionId, 1, "resolver", 60_000)).toBe(true);

        const duringClaim = await submitPlaygroundActionGated({
            id: `c12_late_${RUN}_a`,
            sessionId,
            agentId: "p2",
            round: 1,
            content: "late during resolution",
        });
        expect(duringClaim).toEqual({ ok: false, reason: "resolving" });

        expect(
            await applyPlaygroundResolution(sessionId, { round: 1, token: "resolver" }, {
                currentRound: 2,
                currentRoundPrompt: "round 2",
                transcript: [{ round: 1, gmPrompt: "prompt", actions: [], gmResolution: "done", resolvedAt: new Date().toISOString() }],
            })
        ).toBe(true);

        const afterAdvance = await submitPlaygroundActionGated({
            id: `c12_late_${RUN}_b`,
            sessionId,
            agentId: "p2",
            round: 1,
            content: "late after resolution",
        });
        expect(afterAdvance).toEqual({ ok: false, reason: "stale_round" });

        // Neither refused action exists as a row — rejected, not silently dropped post-read.
        const { rows } = await pgPool().query(
            "SELECT id FROM playground_actions WHERE session_id = $1 AND round = 1 AND agent_id = 'p2'",
            [sessionId]
        );
        expect(rows).toHaveLength(0);
    });

    it("concurrent gated submits for one (session, round, agent) admit exactly one", async () => {
        const sessionId = await seedSession({ participants: ["p1", "p2"], deadlinePassed: false });
        const outcomes = await runConcurrently(
            Array.from({ length: 5 }, (_, i) => () =>
                submitPlaygroundActionGated({
                    id: `c12_race_${RUN}_${i}`,
                    sessionId,
                    agentId: "p1",
                    round: 1,
                    content: `attempt ${i}`,
                })
            )
        );
        const admitted = outcomes.filter((o) => o.ok && o.value.ok);
        expect(admitted).toHaveLength(1);
        const { rows } = await pgPool().query(
            "SELECT id FROM playground_actions WHERE session_id = $1 AND round = 1 AND agent_id = 'p1'",
            [sessionId]
        );
        expect(rows).toHaveLength(1);
    });
});

describe("C12 migration through the real runner (M11-1b review B6/B4)", () => {
    function runMigration() {
        return migrate({ files: [{ file: C12_MIGRATION_FILE, label: "C12 resolution claim" }], dir: C12_SCRIPTS_DIR, connectionString: process.env.POSTGRES_URL });
    }

    it("applies clean and records on a database with no duplicate actions", async () => {
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [C12_MIGRATION_FILE]);
        await runMigration();
        const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [C12_MIGRATION_FILE]);
        expect(rowCount).toBe(1);
    });

    it("REFUSES and records nothing when a (session, round, agent) has duplicate actions — the rows are preserved, not deleted (B4)", async () => {
        // Reconstruct a pre-index database carrying a duplicate: drop the unique index, insert two
        // actions for one (session, round, agent). The migration must refuse rather than delete
        // the reader-visible second row.
        const sessionId = await seedSession({ participants: ["p1"], deadlinePassed: false });
        await pgPool().query(`DROP INDEX IF EXISTS idx_pg_actions_unique`);
        for (const suffix of ["a", "b"]) {
            await pgPool().query(
                `INSERT INTO playground_actions (id, session_id, agent_id, round, content, created_at)
                 VALUES ($1, $2, 'p1', 1, $3, NOW())`,
                [`c12_dup_${RUN}_${suffix}`, sessionId, `content ${suffix}`]
            );
        }
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [C12_MIGRATION_FILE]);

        await expect(runMigration()).rejects.toMatchObject({ code: "P0001" });
        const { rowCount: recorded } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [C12_MIGRATION_FILE]);
        expect(recorded).toBe(0);
        // Both rows survive — nothing was destroyed.
        const { rows } = await pgPool().query(
            "SELECT id FROM playground_actions WHERE session_id = $1 AND round = 1 AND agent_id = 'p1' ORDER BY id",
            [sessionId]
        );
        expect(rows.map((r) => r.id)).toEqual([`c12_dup_${RUN}_a`, `c12_dup_${RUN}_b`]);

        // Resolve by hand (keep one), re-run: applies clean and rebuilds the index.
        await pgPool().query("DELETE FROM playground_actions WHERE id = $1", [`c12_dup_${RUN}_b`]);
        await runMigration();
        const { rowCount: after } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [C12_MIGRATION_FILE]);
        expect(after).toBe(1);
    });
});

describe("C12 migration postconditions", () => {
    it("claim columns and the unique action index exist with the exact shapes", async () => {
        const { rows: cols } = await pgPool().query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'playground_sessions'
               AND column_name IN ('resolve_claim_token', 'resolve_claim_expires_at')`
        );
        expect(cols).toHaveLength(2);

        const { rows: idx } = await pgPool().query<{ cols: string[] }>(`
            SELECT (SELECT array_agg(a.attname::text ORDER BY k.ord)
                    FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols
            FROM pg_class c
            JOIN pg_index i ON i.indexrelid = c.oid
            WHERE c.relname = 'idx_pg_actions_unique'
              AND i.indrelid = 'public.playground_actions'::regclass
              AND i.indisunique AND i.indisvalid
        `);
        expect(idx[0]?.cols).toEqual(["session_id", "agent_id", "round"]);
    });
});
