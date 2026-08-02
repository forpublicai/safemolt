/**
 * M11-1b D5 `[integration]` — durable playground episodic memories against the real database.
 *
 * The headline gate is **persistence across instances**: the defect was a process-local Map even
 * in DB mode, so a later request served elsewhere (or after a cold start) saw a session's
 * memories vanish. That cannot be observed without a database, and a fresh module registry is how
 * a "second instance" is simulated in-process. Memory-mode semantics are in
 * `src/__tests__/playground/d5-durable-memories.test.ts`.
 */
import { join } from "path";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import {
    claimPlaygroundResolution,
    cancelPlaygroundSession,
} from "@/lib/store/playground/db";
import {
    clearPlaygroundMemoriesForAgent,
    getPlaygroundMemoryForAgent,
    listPlaygroundMemoriesForSession,
    storePlaygroundMemory,
    storePlaygroundMemoryFenced,
} from "@/lib/store/playground/agent-memories-db";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");
const SCRIPTS_DIR = join(__dirname, "../../../scripts");
const MIGRATION_FILE = "migrate-playground-agent-memories.sql";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

async function seedAgent(): Promise<string> {
    const id = `d5_agent_${RUN}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted)
         VALUES ($1, $1, '', $2, 0, 0, false, NOW(), true)`,
        [id, `d5_key_${id}`]
    );
    return id;
}

async function seedSession(participantIds: string[]): Promise<string> {
    const id = `d5_sess_${RUN}_${(seq += 1)}`;
    const participants = participantIds.map((agentId) => ({ agentId, agentName: agentId, status: "active", missedRounds: 0 }));
    await pgPool().query(
        `INSERT INTO playground_sessions
           (id, game_id, status, participants, transcript, current_round, max_rounds, created_at, started_at, school_id)
         VALUES ($1, 'd5-game', 'active', $2::jsonb, '[]'::jsonb, 1, 5, NOW(), NOW(), $1)`,
        [id, JSON.stringify(participants)]
    );
    return id;
}

afterAll(async () => {
    await pgPool().query("DELETE FROM playground_agent_memories WHERE session_id LIKE $1", [`d5_sess_${RUN}%`]);
    await pgPool().query("DELETE FROM playground_sessions WHERE id LIKE $1", [`d5_sess_${RUN}%`]);
    await pgPool().query("DELETE FROM agents WHERE id LIKE $1", [`d5_agent_${RUN}%`]);
    await closeIntegrationConnections();
});

describe("durability across instances (the D5 headline)", () => {
    it("a memory written by one module registry is readable from a fresh one — no vanishing", async () => {
        const agent = await seedAgent();
        const sessionId = await seedSession([agent]);
        await storePlaygroundMemory({
            id: `d5_mem_${RUN}`,
            agentId: agent,
            agentName: agent,
            sessionId,
            content: "the treaty held",
            importance: "high",
            roundCreated: 2,
            embedding: [0.1, 0.2],
        });

        // A fresh module registry is a fresh process-local map: before D5 this read returned
        // nothing, which is exactly the silent vanishing the chunk exists to close.
        let seenFromSecondInstance: unknown;
        await jest.isolateModulesAsync(async () => {
            const second = await import("@/lib/store/playground/agent-memories-db");
            seenFromSecondInstance = await second.getPlaygroundMemoryForAgent(sessionId, agent);
        });
        expect(seenFromSecondInstance).toMatchObject({
            agentId: agent,
            sessionId,
            content: "the treaty held",
            importance: "high",
            roundCreated: 2,
            embedding: [0.1, 0.2],
        });
    });

    it("overwrite-per-round semantics: round N replaces round N-1, one row per (agent, session)", async () => {
        const agent = await seedAgent();
        const sessionId = await seedSession([agent]);
        for (const round of [1, 2, 3]) {
            await storePlaygroundMemory({
                id: `d5_mem_${RUN}_r${round}`,
                agentId: agent,
                agentName: agent,
                sessionId,
                content: `round ${round}`,
                importance: "medium",
                roundCreated: round,
            });
        }
        const all = await listPlaygroundMemoriesForSession(sessionId);
        expect(all).toHaveLength(1);
        expect(all[0].content).toBe("round 3");
        expect(all[0].roundCreated).toBe(3);
    });
});

// Named for what it actually covers: the LEASE gate, not coupling to the terminal CAS. These
// cases prove a non-claimant writes nothing; they do not prove the memory and the advance commit
// together, because today they do not (D5 residual in ai/PLAN_M11_1B.md).
describe("the lease-gated write", () => {
    it("only the live claimant writes; a wrong token, a stale round, and a lapsed lease all write nothing", async () => {
        const agent = await seedAgent();
        const sessionId = await seedSession([agent]);
        expect(await claimPlaygroundResolution(sessionId, 1, "winner", 60_000)).toBe(true);

        const input = {
            id: `d5_fenced_${RUN}`,
            agentId: agent,
            agentName: agent,
            sessionId,
            content: "fenced write",
            importance: "high" as const,
            roundCreated: 1,
        };

        expect(await storePlaygroundMemoryFenced(input, { sessionId, round: 1, token: "loser" })).toBe(false);
        expect(await storePlaygroundMemoryFenced(input, { sessionId, round: 99, token: "winner" })).toBe(false);
        expect(await listPlaygroundMemoriesForSession(sessionId)).toHaveLength(0);

        // Lapse the lease: the gated write must refuse — this is the lease-expired loser that
        // used to overwrite episodic memory before the reordering.
        await pgPool().query(
            "UPDATE playground_sessions SET resolve_claim_expires_at = NOW() - interval '1 minute' WHERE id = $1",
            [sessionId]
        );
        expect(await storePlaygroundMemoryFenced(input, { sessionId, round: 1, token: "winner" })).toBe(false);
        expect(await listPlaygroundMemoriesForSession(sessionId)).toHaveLength(0);

        // A live claim writes.
        await pgPool().query(
            "UPDATE playground_sessions SET resolve_claim_expires_at = NOW() + interval '1 minute' WHERE id = $1",
            [sessionId]
        );
        expect(await storePlaygroundMemoryFenced(input, { sessionId, round: 1, token: "winner" })).toBe(true);
        expect(await listPlaygroundMemoriesForSession(sessionId)).toHaveLength(1);
    });
});

describe("cleanup", () => {
    it("cancellation sweeps the session's memories (a TRANSITION fires no cascade)", async () => {
        const agent = await seedAgent();
        const sessionId = await seedSession([agent]);
        await storePlaygroundMemory({
            id: `d5_cancel_${RUN}`, agentId: agent, agentName: agent, sessionId,
            content: "swept on cancel", importance: "low", roundCreated: 1,
        });

        expect((await cancelPlaygroundSession(sessionId, agent, "wrapping up")).outcome).toBe("cancelled");
        expect(await listPlaygroundMemoriesForSession(sessionId)).toHaveLength(0);
        // And the session itself survives — cancellation transitions, never deletes.
        const { rows } = await pgPool().query("SELECT status FROM playground_sessions WHERE id = $1", [sessionId]);
        expect(rows[0].status).toBe("cancelled");
    });

    it("agent deletion cascades memory rows (FK ON DELETE CASCADE)", async () => {
        const agent = await seedAgent();
        const sessionId = await seedSession([agent]);
        await storePlaygroundMemory({
            id: `d5_cascade_${RUN}`, agentId: agent, agentName: agent, sessionId,
            content: "cascade me", importance: "low", roundCreated: 1,
        });
        await pgPool().query("DELETE FROM agents WHERE id = $1", [agent]);
        expect(await listPlaygroundMemoriesForSession(sessionId)).toHaveLength(0);
    });

    it("session deletion cascades memory rows too", async () => {
        const agent = await seedAgent();
        const sessionId = await seedSession([agent]);
        await storePlaygroundMemory({
            id: `d5_sesscascade_${RUN}`, agentId: agent, agentName: agent, sessionId,
            content: "cascade me too", importance: "low", roundCreated: 1,
        });
        await pgPool().query("DELETE FROM playground_sessions WHERE id = $1", [sessionId]);
        const { rows } = await pgPool().query("SELECT 1 FROM playground_agent_memories WHERE session_id = $1", [sessionId]);
        expect(rows).toHaveLength(0);
    });

    it("the agent-scoped sweep removes only that agent's rows", async () => {
        const a = await seedAgent();
        const b = await seedAgent();
        const sessionId = await seedSession([a, b]);
        for (const agentId of [a, b]) {
            await storePlaygroundMemory({
                id: `d5_scope_${RUN}_${agentId}`, agentId, agentName: agentId, sessionId,
                content: "scoped", importance: "low", roundCreated: 1,
            });
        }
        await clearPlaygroundMemoriesForAgent(a);
        const remaining = await listPlaygroundMemoriesForSession(sessionId);
        expect(remaining.map((m) => m.agentId)).toEqual([b]);
        expect(await getPlaygroundMemoryForAgent(sessionId, a)).toBeNull();
    });
});

describe("D5 migration through the real runner", () => {
    it("applies clean and records, executing its DDL and postconditions", async () => {
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        await migrate({
            files: [{ file: MIGRATION_FILE, label: "D5 playground memories" }],
            dir: SCRIPTS_DIR,
            connectionString: process.env.POSTGRES_URL,
        });
        const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [MIGRATION_FILE]);
        expect(rowCount).toBe(1);
    });

    it("the table carries the composite primary key and both cascading FKs", async () => {
        const { rows: pk } = await pgPool().query<{ cols: string[] }>(`
            SELECT (SELECT array_agg(a.attname::text ORDER BY k.ord)
                    FROM unnest(i.indkey) WITH ORDINALITY AS k(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = k.attnum) AS cols
            FROM pg_index i
            WHERE i.indrelid = 'public.playground_agent_memories'::regclass AND i.indisprimary
        `);
        expect(pk[0]?.cols).toEqual(["agent_id", "session_id"]);

        const { rows: fks } = await pgPool().query(`
            SELECT 1 FROM pg_constraint con
            JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
            WHERE con.conrelid = 'public.playground_agent_memories'::regclass
              AND con.contype = 'f' AND con.confdeltype = 'c'
              AND ((con.confrelid = 'public.agents'::regclass AND att.attname = 'agent_id')
                OR (con.confrelid = 'public.playground_sessions'::regclass AND att.attname = 'session_id'))
        `);
        expect(fks).toHaveLength(2);
    });
});
