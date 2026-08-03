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
import { raceAgainstHeldLock } from "./helpers/concurrency";
import {
    applyPlaygroundResolution,
    claimPlaygroundResolution,
    cancelPlaygroundSession,
} from "@/lib/store/playground/db";
import {
    clearPlaygroundMemoriesForAgent,
    getPlaygroundMemoryForAgent,
    listPlaygroundMemoriesForSession,
    storePlaygroundMemory,
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

// The D5 atomic follow-up: the round's memories are written INSIDE the terminal CAS, so these
// cases prove the stronger property the lease-gated writer could not — the advance and the round's
// memories commit together, or neither does.
describe("the CAS-coupled write", () => {
    const memoryFor = (agentId: string, sessionId: string, content: string, suffix: string) => ({
        id: `d5_cas_${RUN}_${suffix}`,
        agentId,
        agentName: agentId,
        sessionId,
        content,
        importance: "high" as const,
        roundCreated: 1,
        createdAt: new Date().toISOString(),
    });

    it("a losing CAS writes neither the advance nor any memory; the winner writes both", async () => {
        const agent = await seedAgent();
        const sessionId = await seedSession([agent]);
        expect(await claimPlaygroundResolution(sessionId, 1, "winner", 60_000)).toBe(true);

        const row = (suffix: string) => memoryFor(agent, sessionId, "fenced write", suffix);
        const roundOf = async () =>
            Number((await pgPool().query("SELECT current_round FROM playground_sessions WHERE id = $1", [sessionId])).rows[0].current_round);

        expect(await applyPlaygroundResolution(sessionId, { round: 1, token: "loser" }, { currentRound: 2 }, [row("a")])).toBe(false);
        expect(await applyPlaygroundResolution(sessionId, { round: 99, token: "winner" }, { currentRound: 100 }, [row("b")])).toBe(false);
        expect(await listPlaygroundMemoriesForSession(sessionId)).toHaveLength(0);
        expect(await roundOf()).toBe(1);

        // Lapse the lease: this is the lease-expired loser that used to overwrite episodic memory.
        // The CAS carries the expiry, so the memory insert never runs.
        await pgPool().query(
            "UPDATE playground_sessions SET resolve_claim_expires_at = NOW() - interval '1 minute' WHERE id = $1",
            [sessionId]
        );
        expect(await applyPlaygroundResolution(sessionId, { round: 1, token: "winner" }, { currentRound: 2 }, [row("c")])).toBe(false);
        expect(await listPlaygroundMemoriesForSession(sessionId)).toHaveLength(0);
        expect(await roundOf()).toBe(1);

        // A live claim writes both, in one statement.
        await pgPool().query(
            "UPDATE playground_sessions SET resolve_claim_expires_at = NOW() + interval '1 minute' WHERE id = $1",
            [sessionId]
        );
        expect(await applyPlaygroundResolution(sessionId, { round: 1, token: "winner" }, { currentRound: 2 }, [row("d")])).toBe(true);
        expect(await listPlaygroundMemoriesForSession(sessionId)).toHaveLength(1);
        expect(await roundOf()).toBe(2);
    });

    it("writes every participant's memory or none — no half-remembered round", async () => {
        const [a, b] = [await seedAgent(), await seedAgent()];
        const sessionId = await seedSession([a, b]);
        expect(await claimPlaygroundResolution(sessionId, 1, "multi", 60_000)).toBe(true);

        expect(
            await applyPlaygroundResolution(sessionId, { round: 1, token: "multi" }, { currentRound: 2 }, [
                memoryFor(a, sessionId, "a remembers", "multi_a"),
                memoryFor(b, sessionId, "b remembers", "multi_b"),
            ])
        ).toBe(true);
        const stored = await listPlaygroundMemoriesForSession(sessionId);
        expect(stored.map((m) => m.content).sort()).toEqual(["a remembers", "b remembers"]);
    });

    it("treats an empty payload as a won CAS, not a lost one (the all-forfeited path)", async () => {
        const agent = await seedAgent();
        const sessionId = await seedSession([agent]);
        expect(await claimPlaygroundResolution(sessionId, 1, "empty", 60_000)).toBe(true);
        expect(await applyPlaygroundResolution(sessionId, { round: 1, token: "empty" }, { currentRound: 2 }, [])).toBe(true);
        expect(await listPlaygroundMemoriesForSession(sessionId)).toHaveLength(0);
    });

    it("ROLLS BACK THE ADVANCE when any one memory row is unwritable — the coupling itself", async () => {
        // The gate that no split-statement implementation can pass, in either order. Memories
        // first (the shape this replaced): the good row commits, then the bad row raises, leaving
        // a half-remembered round. Advance first: current_round is already 2 when the bad row
        // raises. One statement means the failure takes everything with it, so the round stays
        // consistent and retryable.
        const [good, bad] = [await seedAgent(), await seedAgent()];
        const sessionId = await seedSession([good, bad]);
        expect(await claimPlaygroundResolution(sessionId, 1, "rollback", 60_000)).toBe(true);

        await expect(
            applyPlaygroundResolution(sessionId, { round: 1, token: "rollback" }, { currentRound: 2 }, [
                memoryFor(good, sessionId, "would have landed", "rb_good"),
                // `content` is NOT NULL: this row cannot be inserted.
                { ...memoryFor(bad, sessionId, "unwritable", "rb_bad"), content: null as unknown as string },
            ])
        ).rejects.toThrow();

        expect(await listPlaygroundMemoriesForSession(sessionId)).toHaveLength(0);
        const { rows } = await pgPool().query(
            "SELECT current_round, resolve_claim_token FROM playground_sessions WHERE id = $1",
            [sessionId]
        );
        expect(Number(rows[0].current_round)).toBe(1);
        // The claim survives too — the whole statement rolled back, so this resolver can retry.
        expect(rows[0].resolve_claim_token).toBe("rollback");
    });

    it("writes one row per agent even when a participant is listed twice", async () => {
        // Two rows with the same conflict key in one insert raise 21000, which — coupled to the
        // advance — would wedge the session, because every retry rebuilds the same payload.
        const agent = await seedAgent();
        const sessionId = await seedSession([agent]);
        expect(await claimPlaygroundResolution(sessionId, 1, "dup", 60_000)).toBe(true);

        expect(
            await applyPlaygroundResolution(sessionId, { round: 1, token: "dup" }, { currentRound: 2 }, [
                memoryFor(agent, sessionId, "first", "dup_1"),
                memoryFor(agent, sessionId, "second", "dup_2"),
            ])
        ).toBe(true);
        const stored = await listPlaygroundMemoriesForSession(sessionId);
        expect(stored).toHaveLength(1);
        expect(stored[0].content).toBe("second");
    });

    it("a deleted participant's memory cannot VETO the advance", async () => {
        // `playground_sessions.participants` is JSONB with no FK, but the memory table's agent_id
        // has a hard one. Coupling the two means a bare insert would raise 23503 for an agent
        // deleted mid-session and take the advance with it — leaving the session permanently
        // unresolvable, because every retry re-reads the same participant. The advance must win.
        const [alive, doomed] = [await seedAgent(), await seedAgent()];
        const sessionId = await seedSession([alive, doomed]);
        await pgPool().query("DELETE FROM agents WHERE id = $1", [doomed]);
        expect(await claimPlaygroundResolution(sessionId, 1, "veto", 60_000)).toBe(true);

        expect(
            await applyPlaygroundResolution(sessionId, { round: 1, token: "veto" }, { currentRound: 2 }, [
                memoryFor(alive, sessionId, "still here", "veto_alive"),
                memoryFor(doomed, sessionId, "gone", "veto_doomed"),
            ])
        ).toBe(true);

        const stored = await listPlaygroundMemoriesForSession(sessionId);
        expect(stored.map((m) => m.content)).toEqual(["still here"]);
        const { rows } = await pgPool().query("SELECT current_round FROM playground_sessions WHERE id = $1", [sessionId]);
        expect(Number(rows[0].current_round)).toBe(2);
    });

    it("survives a participant deletion that COMMITS mid-statement — why the pin is FOR KEY SHARE", async () => {
        // The pre-deletion case above would pass with a plain snapshot join, so it cannot show why
        // the lock is there. This one can: the delete is issued but NOT yet committed when the
        // resolution starts, so the statement snapshot still shows the agent. Without the pin, the
        // liveness join admits the row, the insert's FK check then blocks on the delete's lock,
        // sees the committed deletion, raises 23503 and takes the advance down with it. With the
        // pin, the resolution waits on the same lock and re-reads the agent as absent instead.
        const [alive, doomed] = [await seedAgent(), await seedAgent()];
        const sessionId = await seedSession([alive, doomed]);
        expect(await claimPlaygroundResolution(sessionId, 1, "race", 60_000)).toBe(true);

        const race = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query("DELETE FROM agents WHERE id = $1", [doomed]);
            },
            contend: () =>
                applyPlaygroundResolution(sessionId, { round: 1, token: "race" }, { currentRound: 2 }, [
                    memoryFor(alive, sessionId, "survivor", "race_alive"),
                    memoryFor(doomed, sessionId, "doomed", "race_doomed"),
                ]),
            contenderMarker: "d5:resolution-cas",
        });

        expect(race.observedBlocked).toBe(true);
        expect(race.result).toBe(true); // no 23503: the advance won
        const stored = await listPlaygroundMemoriesForSession(sessionId);
        expect(stored.map((m) => m.content)).toEqual(["survivor"]);
        const { rows } = await pgPool().query("SELECT current_round FROM playground_sessions WHERE id = $1", [sessionId]);
        expect(Number(rows[0].current_round)).toBe(2);
    });

    it("round-trips a memory carried through the CAS, embedding and all", async () => {
        const agent = await seedAgent();
        const sessionId = await seedSession([agent]);
        expect(await claimPlaygroundResolution(sessionId, 1, "rt", 60_000)).toBe(true);

        const embedding = [0.5, -0.25, 0.125];
        expect(
            await applyPlaygroundResolution(sessionId, { round: 1, token: "rt" }, { currentRound: 2 }, [
                { ...memoryFor(agent, sessionId, "carried through the CAS", "rt"), embedding, roundCreated: 7 },
            ])
        ).toBe(true);
        const [stored] = await listPlaygroundMemoriesForSession(sessionId);
        expect(stored).toMatchObject({
            id: `d5_cas_${RUN}_rt`,
            agentId: agent,
            content: "carried through the CAS",
            importance: "high",
            roundCreated: 7,
            embedding,
        });
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
