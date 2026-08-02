/**
 * M11-1 C4 `[integration]` — the db side of the stale-name release.
 *
 * Two assertions here exist because the old draft's gates would have passed while the primitive
 * stayed broken:
 *
 *  (a) **The statement must be observed to execute.** "An over-window pristine agent is gone" is
 *      satisfied today by a swallowed error doing nothing to a *fresh* agent, so it is paired with
 *      a characterization of the pre-fix expression raising SQLSTATE 42883 and deleting nothing.
 *  (b) **The catch must not be hiding anything else.** The swallow stays — registration must not
 *      fail because cleanup did — so the suite asserts the cleanup path logs zero errors.
 */
import { neonSql, pgPool, closeIntegrationConnections } from "./helpers/db";
import { raceAgainstHeldLock } from "./helpers/concurrency";
import { cleanupStaleUnclaimedAgent, authenticateAndTouchByApiKey } from "@/lib/store/agents/db";

const sql = neonSql();

interface SeedOptions {
    name: string;
    ageHours?: number;
    isVetted?: boolean;
    isClaimed?: boolean;
    lastActiveAt?: string | null;
}

let seq = 0;

async function seedAgent(options: SeedOptions): Promise<{ id: string; apiKey: string }> {
    const id = `c4_agent_${(seq += 1)}`;
    const apiKey = `c4_key_${seq}`;
    const createdAt = new Date(Date.now() - (options.ageHours ?? 2) * 3600_000).toISOString();
    await pgPool().query(
        `INSERT INTO agents (id, name, description, api_key, points, follower_count, is_claimed, created_at, is_vetted, last_active_at)
         VALUES ($1, $2, '', $3, 0, 0, $4, $5, $6, $7)`,
        [id, options.name, apiKey, options.isClaimed ?? false, createdAt, options.isVetted ?? false, options.lastActiveAt ?? null]
    );
    return { id, apiKey };
}

async function agentExists(id: string): Promise<boolean> {
    const { rows } = await pgPool().query("SELECT 1 FROM agents WHERE id = $1", [id]);
    return rows.length > 0;
}

beforeEach(async () => {
    await pgPool().query("DELETE FROM agents WHERE id LIKE 'c4\\_%'");
    delete process.env.AGENT_NAME_RELEASE_HOURS;
});

afterAll(async () => {
    await pgPool().query("DELETE FROM agents WHERE id LIKE 'c4\\_%'");
    await closeIntegrationConnections();
});

describe("characterization: the pre-fix expression never ran", () => {
    it("raises 42883, because text * interval has no operator", async () => {
        // `(${releaseHours} || 1)` was string concatenation, not a default: `$1 || 1` resolves
        // through `text || anynonarray` and yields the text '11'. This is why the primitive was
        // latent, and why the obvious one-line "fix" would have *activated* it.
        await expect(
            sql`SELECT NOW() - (${1} || 1) * INTERVAL '1 hour' AS cutoff`
        ).rejects.toMatchObject({ code: "42883" });
    });

    it("confirms the concatenation itself was real", async () => {
        const rows = (await sql`SELECT pg_typeof(${1}::text || 1)::text AS kind, (${1}::text || 1) AS value`) as Array<{
            kind: string;
            value: string;
        }>;
        expect(rows[0].kind).toBe("text");
        expect(rows[0].value).toBe("11");
    });
});

describe("the fixed statement executes and deletes only pristine rows", () => {
    it("releases a pristine unclaimed registration past the window", async () => {
        const agent = await seedAgent({ name: "c4_pristine" });
        await cleanupStaleUnclaimedAgent("c4_pristine");
        expect(await agentExists(agent.id)).toBe(false);
    });

    it("spares vetted, ever-authenticated, claimed, and in-window rows", async () => {
        const cases = [
            await seedAgent({ name: "c4_spare_a", isVetted: true }),
            await seedAgent({ name: "c4_spare_b", lastActiveAt: new Date(Date.now() - 90 * 86400_000).toISOString() }),
            await seedAgent({ name: "c4_spare_c", isClaimed: true }),
            await seedAgent({ name: "c4_spare_d", ageHours: 0 }),
        ];
        for (const name of ["c4_spare_a", "c4_spare_b", "c4_spare_c", "c4_spare_d"]) {
            await cleanupStaleUnclaimedAgent(name);
        }
        for (const agent of cases) {
            expect([agent.id, await agentExists(agent.id)]).toEqual([agent.id, true]);
        }
    });

    it("honours a configured window, and a malformed value never reaches make_interval", async () => {
        process.env.AGENT_NAME_RELEASE_HOURS = "24";
        const within = await seedAgent({ name: "c4_within", ageHours: 23 });
        const past = await seedAgent({ name: "c4_past", ageHours: 25 });
        await cleanupStaleUnclaimedAgent("c4_within");
        await cleanupStaleUnclaimedAgent("c4_past");
        expect(await agentExists(within.id)).toBe(true);
        expect(await agentExists(past.id)).toBe(false);

        process.env.AGENT_NAME_RELEASE_HOURS = "banana";
        const malformed = await seedAgent({ name: "c4_malformed", ageHours: 2 });
        await cleanupStaleUnclaimedAgent("c4_malformed");
        // NaN would have raised inside make_interval and been swallowed, leaving the row.
        expect(await agentExists(malformed.id)).toBe(false);
    });

    it("logs nothing — the swallow is not hiding a second failure", async () => {
        const errors: unknown[][] = [];
        const original = console.error;
        console.error = (...args: unknown[]) => {
            errors.push(args);
        };
        try {
            const agent = await seedAgent({ name: "c4_quiet" });
            await cleanupStaleUnclaimedAgent("c4_quiet");
            expect(await agentExists(agent.id)).toBe(false);
        } finally {
            console.error = original;
        }
        expect(errors).toEqual([]);
    });
});

describe("first authentication versus cleanup", () => {
    /**
     * The blocking side runs the **actual cleanup DELETE**, not a placeholder lock.
     *
     * An earlier version of this test held a bare `SELECT ... FOR UPDATE` and only called cleanup
     * *afterwards*. That would pass even if authentication regressed to a `SELECT` followed by a
     * separate `UPDATE`, because no cleanup was ever admitted into the window between them — it
     * asserted that authentication can block on a row lock, which was never the question.
     *
     * The marker identifies the contender by its statement text, so an unrelated blocked backend
     * cannot be mistaken for the query under test.
     */
    const CLEANUP_DELETE = `DELETE FROM agents
        WHERE LOWER(name) = LOWER($1)
          AND is_claimed = false
          AND is_vetted = false
          AND last_active_at IS NULL
          AND created_at < NOW() - make_interval(hours => 1)`;

    it("cleanup wins: the agent is released and authentication reports no agent", async () => {
        const agent = await seedAgent({ name: "c4_racer_delete" });

        const observation = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query(CLEANUP_DELETE, ["c4_racer_delete"]);
            },
            contend: () => authenticateAndTouchByApiKey(agent.apiKey),
            contenderMarker: "SET last_active_at = NOW()",
        });

        // Authentication genuinely waited on the cleanup's row lock — not merely took longer.
        expect(observation.observedBlocked).toBe(true);
        // The delete committed, so there is no agent to authenticate. What must never happen is
        // the other order: authenticated first, destroyed after.
        expect(observation.result).toBeNull();
        expect(await agentExists(agent.id)).toBe(false);
    });

    /**
     * The authentication statement, held open so the cleanup contends with it.
     *
     * Verbatim from `authenticateAndTouchByApiKey` (`store/agents/db.ts`) apart from the parameter
     * placeholders, because holding a *paraphrase* open would prove something about a query the
     * deploy never runs.
     */
    const AUTH_TOUCH = `UPDATE agents
        SET last_active_at = NOW()
        WHERE api_key = $1
          AND (
            last_active_at IS NULL
            OR last_active_at < NOW() - make_interval(secs => 300)
          )
        RETURNING id`;

    it("authentication wins: cleanup blocks on the stamp and then deletes nothing", async () => {
        // **This direction has to be raced from the other side.** The earlier version held the
        // cleanup and *rolled it back inside `hold()`* — and the helper does not start the contender
        // until `hold()` returns, so authentication ran with nothing to contend against. It asserted
        // no blocking either, so it was a sequential test wearing a race's clothes: it would have
        // passed against the two-statement authentication C4 replaced.
        //
        // Racing it properly means holding the **authentication** open and making the cleanup the
        // contender. The cleanup must block on the locked row, and then — re-evaluating its
        // predicate after the commit, under read-committed — find `last_active_at` no longer NULL
        // and match zero rows. That is the guarantee: authenticated first, never destroyed after.
        const agent = await seedAgent({ name: "c4_racer_keep" });

        const observation = await raceAgainstHeldLock({
            hold: async (holder) => {
                const { rowCount } = await holder.query(AUTH_TOUCH, [agent.apiKey]);
                // The lock only exists if the statement matched the row.
                expect(rowCount).toBe(1);
            },
            contend: () => cleanupStaleUnclaimedAgent("c4_racer_keep"),
            contenderMarker: "make_interval(hours =>",
        });

        // The cleanup genuinely waited on the authentication's row lock — not merely took longer.
        expect(observation.observedBlocked).toBe(true);

        // The holder committed, so the stamp landed...
        const { rows } = await pgPool().query<{ last_active_at: Date | null }>(
            "SELECT last_active_at FROM agents WHERE id = $1",
            [agent.id]
        );
        expect(rows[0].last_active_at).not.toBeNull();

        // ...and the cleanup, released and re-evaluated, could not take the row.
        expect(await agentExists(agent.id)).toBe(true);
    });

    it("authentication returns the agent, and a later cleanup still cannot take it", async () => {
        // The uncontended half of the same claim, kept separate so the race above is not asked to
        // prove two things at once.
        const agent = await seedAgent({ name: "c4_keep_uncontended" });

        const authenticated = await authenticateAndTouchByApiKey(agent.apiKey);
        expect(authenticated?.id).toBe(agent.id);

        await cleanupStaleUnclaimedAgent("c4_keep_uncontended");
        expect(await agentExists(agent.id)).toBe(true);
    });

    it("skips the write when the stamp is already fresh", async () => {
        const stamp = new Date().toISOString();
        const agent = await seedAgent({ name: "c4_fresh", lastActiveAt: stamp });
        const result = await authenticateAndTouchByApiKey(agent.apiKey);
        expect(result?.id).toBe(agent.id);

        const { rows } = await pgPool().query<{ last_active_at: Date }>(
            "SELECT last_active_at FROM agents WHERE id = $1",
            [agent.id]
        );
        expect(rows[0].last_active_at.toISOString()).toBe(new Date(stamp).toISOString());
    });
});
