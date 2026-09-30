/**
 * M11-2 P0.4 `[integration]` — recordAgentLoopTick against the real database.
 *
 * The unit tests around this deliverable (src/__tests__/lib/agent-loop/state.test.ts) mock `sql`
 * and only prove the shape of the statement. This is what only a database can show: the insert
 * actually lands, the columns round-trip with the right types (booleans stay booleans), the
 * migration's index exists so the soak query's `WHERE created_at > ...` scan has something to use,
 * and the outcome CHECK constraint actually refuses a value outside the three the store function
 * ever sends (a code-bug guard, not a user-facing one — see the migration file's comment).
 *
 * `beforeAll` force-re-runs `migrate-m11-tick-log.sql` through the REAL runner (the
 * c24-professor-rotation.test.ts pattern: clear the `_migrations` record, then call `migrate()`
 * again with just this file). The harness's reserved database persists across runs, so without this
 * a file already recorded from an earlier run of this suite would silently SKIP — meaning a later
 * edit to the migration (this file gained a CHECK constraint and a stronger postcondition after
 * first landing) would never actually be re-applied or re-verified against the real database.
 */
import { pgPool, closeIntegrationConnections } from "./helpers/db";
import { recordAgentLoopTick } from "@/lib/agent-loop/state";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");

const MIGRATION = { file: "migrate-m11-tick-log.sql", label: "Agent loop tick-outcome instrumentation" };
const connectionString = process.env.POSTGRES_URL as string;
const migrationsDir = require("path").join(__dirname, "..", "..", "..", "scripts");

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
const AGENT_ID = `p04_agent_${RUN}`;

async function ticksFor(agentId: string) {
    const { rows } = await pgPool().query(
        `SELECT agent_id, outcome, inference_consumed, terminal_action
         FROM agent_loop_tick_log WHERE agent_id = $1 ORDER BY id ASC`,
        [agentId]
    );
    return rows;
}

beforeAll(async () => {
    await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION.file]);
    await migrate({ files: [MIGRATION], dir: migrationsDir, connectionString });
});

afterAll(async () => {
    await pgPool().query("DELETE FROM agent_loop_tick_log WHERE agent_id = $1", [AGENT_ID]);
    await closeIntegrationConnections();
});

describe("migrate-m11-tick-log.sql", () => {
    it("re-runs cleanly (idempotent) and its postcondition passes against the real database", async () => {
        // The beforeAll re-run already proved this by not throwing; running it a SECOND time here
        // proves idempotency specifically (re-running is the documented recovery path).
        await expect(
            migrate({ files: [MIGRATION], dir: migrationsDir, connectionString })
        ).resolves.not.toThrow();
    });

    it("refuses an outcome value outside acted | skipped | error", async () => {
        await expect(
            pgPool().query(
                `INSERT INTO agent_loop_tick_log (agent_id, outcome, inference_consumed, terminal_action)
                 VALUES ($1, 'bogus', true, true)`,
                [`p04_bad_${RUN}`]
            )
        ).rejects.toThrow(/violates check constraint|chk_agent_loop_tick_log_outcome/i);
    });
});

describe("recordAgentLoopTick", () => {
    it("inserts a row that round-trips outcome and both booleans", async () => {
        await recordAgentLoopTick({
            agentId: AGENT_ID,
            outcome: "acted",
            inferenceConsumed: true,
            terminalAction: true,
        });

        const rows = await ticksFor(AGENT_ID);
        expect(rows).toEqual([
            { agent_id: AGENT_ID, outcome: "acted", inference_consumed: true, terminal_action: true },
        ]);
    });

    it("takes no FK on agent_id — a tick for an agent id that was never inserted into agents still lands", async () => {
        const ghostAgentId = `p04_ghost_${RUN}`;
        await recordAgentLoopTick({
            agentId: ghostAgentId,
            outcome: "skipped",
            inferenceConsumed: true,
            terminalAction: false,
        });

        const rows = await ticksFor(ghostAgentId);
        expect(rows).toEqual([
            { agent_id: ghostAgentId, outcome: "skipped", inference_consumed: true, terminal_action: false },
        ]);

        await pgPool().query("DELETE FROM agent_loop_tick_log WHERE agent_id = $1", [ghostAgentId]);
    });

    it("appends one row per call, in order, rather than upserting on agent_id", async () => {
        await recordAgentLoopTick({
            agentId: AGENT_ID,
            outcome: "error",
            inferenceConsumed: false,
            terminalAction: false,
        });

        const rows = await ticksFor(AGENT_ID);
        expect(rows.map((r) => r.outcome)).toEqual(["acted", "error"]);
    });

    it("the migration's created_at index exists for the soak query's 7-day scan", async () => {
        const { rows } = await pgPool().query(
            "SELECT 1 FROM pg_indexes WHERE indexname = 'idx_agent_loop_tick_log_created_at'"
        );
        expect(rows).toHaveLength(1);
    });
});
