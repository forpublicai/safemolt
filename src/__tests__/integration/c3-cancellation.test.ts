/**
 * M11-1 C3 `[integration]` — cancellation as an attributed transition, against the real database:
 * the cancel-vs-resolution precedence, the fenced loser after an unclaimed cancel, the
 * expiry-vs-activation race (observed via pg_blocking_pids, not wall clock), and the migration
 * postconditions. Memory-mode and route-level behavior is in
 * `src/__tests__/playground/c3-cancellation.test.ts`.
 */
import { join } from "path";
import { closeIntegrationConnections, pgPool } from "./helpers/db";
import { raceAgainstHeldLock } from "./helpers/concurrency";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const { migrate } = require("../../../scripts/migrate.js");
const C3_SCRIPTS_DIR = join(__dirname, "../../../scripts");
const C3_MIGRATION_FILE = "migrate-playground-cancellation.sql";
import {
    applyPlaygroundResolution,
    cancelPlaygroundSession,
    claimPlaygroundResolution,
    expireStalePendingSessions,
} from "@/lib/store/playground/db";
import { PLAYGROUND_SYSTEM_EXPIRED_REASON } from "@/lib/playground/types";

const RUN = `${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
let seq = 0;

async function seedAgent(): Promise<string> {
    const id = `c3_agent_${RUN}_${(seq += 1)}`;
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted)
         VALUES ($1, $1, '', $2, 0, 0, false, NOW(), true)`,
        [id, `c3_key_${RUN}_${seq}`]
    );
    return id;
}

async function seedSession(options: {
    participants: string[];
    status?: string;
    createdAgoMs?: number;
}): Promise<string> {
    const id = `c3_sess_${RUN}_${(seq += 1)}`;
    const participants = options.participants.map((agentId) => ({
        agentId,
        agentName: agentId,
        status: "active",
        missedRounds: 0,
    }));
    await pgPool().query(
        `INSERT INTO playground_sessions
           (id, game_id, status, participants, transcript, current_round, current_round_prompt,
            round_deadline, max_rounds, created_at, started_at, school_id)
         VALUES ($1, 'c3-game', $2, $3::jsonb, '[]'::jsonb, 1, 'prompt',
                 NOW() + interval '1 hour', 5, NOW() - make_interval(secs => $4), NOW(), $1)`,
        [id, options.status ?? "active", JSON.stringify(participants), (options.createdAgoMs ?? 0) / 1000]
    );
    return id;
}

async function sessionRow(id: string) {
    const { rows } = await pgPool().query<{
        status: string;
        cancelled_at: Date | null;
        cancelled_by_agent_id: string | null;
        cancelled_reason: string | null;
    }>(
        "SELECT status, cancelled_at, cancelled_by_agent_id, cancelled_reason FROM playground_sessions WHERE id = $1",
        [id]
    );
    return rows[0];
}

afterAll(async () => {
    await pgPool().query("DELETE FROM activity_events WHERE entity_id LIKE $1", [`c3_sess_${RUN}%`]);
    await pgPool().query("DELETE FROM playground_sessions WHERE id LIKE $1", [`c3_sess_${RUN}%`]);
    await pgPool().query("DELETE FROM agents WHERE id LIKE $1", [`c3_agent_${RUN}%`]);
    await closeIntegrationConnections();
});

describe("cancel-vs-resolution precedence", () => {
    it("a live claim refuses cancellation; the resolution then completes normally", async () => {
        const agent = await seedAgent();
        const sessionId = await seedSession({ participants: [agent] });
        expect(await claimPlaygroundResolution(sessionId, 1, "resolver_tok", 60_000)).toBe(true);

        const refused = await cancelPlaygroundSession(sessionId, agent, "too slow");
        expect(refused).toEqual({ outcome: "resolution_in_progress" });
        expect((await sessionRow(sessionId)).status).toBe("active");

        // The paid work in flight lands unharmed.
        expect(
            await applyPlaygroundResolution(sessionId, { round: 1, token: "resolver_tok" }, {
                currentRound: 2,
                currentRoundPrompt: "round 2",
                transcript: [],
            })
        ).toBe(true);
    });

    it("an unclaimed cancel wins; a resolver completing later finds zero rows", async () => {
        const agent = await seedAgent();
        const sessionId = await seedSession({ participants: [agent] });

        const cancelled = await cancelPlaygroundSession(sessionId, agent, "changed my mind");
        expect(cancelled).toEqual({ outcome: "cancelled", previousStatus: "active" });

        // A resolver that somehow raced past the claim step cannot overwrite 'cancelled'.
        expect(
            await applyPlaygroundResolution(sessionId, { round: 1, token: "late_resolver" }, { status: "completed" })
        ).toBe(false);
        expect((await sessionRow(sessionId)).status).toBe("cancelled");
    });

    it("a LAPSED claim does not make a session uncancellable", async () => {
        // The plan's predicate reads `resolve_claim_token IS NULL`; implemented as "no LIVE
        // claim" deliberately — a crashed resolver's stale token would otherwise brick
        // cancellation forever, and C12's fence already rejects that resolver's late write
        // against the cancelled row (asserted above).
        const agent = await seedAgent();
        const sessionId = await seedSession({ participants: [agent] });
        expect(await claimPlaygroundResolution(sessionId, 1, "crashed_tok", 60_000)).toBe(true);
        await pgPool().query(
            "UPDATE playground_sessions SET resolve_claim_expires_at = NOW() - interval '1 minute' WHERE id = $1",
            [sessionId]
        );

        const cancelled = await cancelPlaygroundSession(sessionId, agent, "resolver died");
        expect(cancelled).toEqual({ outcome: "cancelled", previousStatus: "active" });
    });
});

describe("nonparticipant probes (db)", () => {
    it("active, completed, cancelled, and nonexistent sessions all answer not_found", async () => {
        const outsider = await seedAgent();
        const owner = await seedAgent();
        const activeId = await seedSession({ participants: [owner] });
        const completedId = await seedSession({ participants: [owner], status: "completed" });
        const cancelledId = await seedSession({ participants: [owner], status: "cancelled" });

        for (const target of [activeId, completedId, cancelledId, "c3_missing"]) {
            expect(await cancelPlaygroundSession(target, outsider, "probe")).toEqual({ outcome: "not_found" });
        }
        expect((await sessionRow(activeId)).status).toBe("active");
    });
});

describe("expiry sweep", () => {
    it("transitions stale pending sessions with the system sentinel and NULL actor", async () => {
        const staleId = await seedSession({ participants: [], status: "pending", createdAgoMs: 25 * 3_600_000 });
        const freshId = await seedSession({ participants: [], status: "pending" });

        const expired = await expireStalePendingSessions(24 * 3_600_000);
        expect(expired).toContain(staleId);
        expect(expired).not.toContain(freshId);

        const stale = await sessionRow(staleId);
        expect(stale.status).toBe("cancelled");
        expect(stale.cancelled_by_agent_id).toBeNull();
        expect(stale.cancelled_reason).toBe(PLAYGROUND_SYSTEM_EXPIRED_REASON);
        expect((await sessionRow(freshId)).status).toBe("pending");
    });

    it("expiry-vs-activation race: a session activating mid-sweep is not expired", async () => {
        const sessionId = await seedSession({ participants: [], status: "pending", createdAgoMs: 25 * 3_600_000 });

        const outcome = await raceAgainstHeldLock<string[]>({
            hold: async (holder) => {
                // Activation in flight: the row is locked with status already moved to 'active',
                // uncommitted. The sweep must block on it and re-evaluate after commit.
                await holder.query("UPDATE playground_sessions SET status = 'active', started_at = NOW() WHERE id = $1", [
                    sessionId,
                ]);
            },
            contend: async () => await expireStalePendingSessions(24 * 3_600_000),
            contenderMarker: "SET status = 'cancelled'",
        });

        expect(outcome.observedBlocked).toBe(true);
        expect(outcome.result).not.toContain(sessionId);
        expect((await sessionRow(sessionId)).status).toBe("active");
    });
});

describe("C3 migration through the real runner (M11-1b review B6)", () => {
    it("applies clean and records, executing its DDL and postconditions", async () => {
        await pgPool().query("DELETE FROM _migrations WHERE filename = $1", [C3_MIGRATION_FILE]);
        await migrate({ files: [{ file: C3_MIGRATION_FILE, label: "C3 cancellation" }], dir: C3_SCRIPTS_DIR, connectionString: process.env.POSTGRES_URL });
        const { rowCount } = await pgPool().query("SELECT 1 FROM _migrations WHERE filename = $1", [C3_MIGRATION_FILE]);
        expect(rowCount).toBe(1);
    });
});

describe("C3 migration postconditions", () => {
    it("cancellation columns exist with the attribution FK", async () => {
        const { rows: cols } = await pgPool().query(
            `SELECT column_name FROM information_schema.columns
             WHERE table_schema = 'public' AND table_name = 'playground_sessions'
               AND column_name IN ('cancelled_at', 'cancelled_by_agent_id', 'cancelled_reason')`
        );
        expect(cols).toHaveLength(3);

        const { rows: fk } = await pgPool().query(
            `SELECT 1 FROM pg_constraint con
             JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY (con.conkey)
             WHERE con.conrelid = 'public.playground_sessions'::regclass
               AND con.contype = 'f' AND con.confrelid = 'public.agents'::regclass
               AND att.attname = 'cancelled_by_agent_id'`
        );
        expect(fk).toHaveLength(1);
    });
});
