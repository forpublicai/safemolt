/**
 * M11-1 C0 — the harness proves itself before any gate is allowed to rely on it.
 *
 * If these assertions do not hold, every `[integration]` race gate in PLAN_M11_1 is void and the
 * executor stops. A race harness that cannot detect a race is worse than no harness, because it
 * reports success.
 *
 * The four things under test:
 *   1. a known-conflicting pair is *observed* to block, with the blocker identified by pid;
 *   2. a known-independent pair is observed *not* to block;
 *   3. the Neon HTTP driver auto-commits per call, so a standalone `SELECT ... FOR UPDATE` on it
 *      holds nothing — the premise that makes the `pg`-side lock holder necessary;
 *   4. `sql.transaction` batch elements cannot read one another's `RETURNING`, which is why
 *      several chunks specify a data-modifying CTE rather than a batch.
 */
import { neonSql, pgClient, pgPool, closeIntegrationConnections } from "./helpers/db";
import { raceAgainstHeldLock } from "./helpers/concurrency";

// CommonJS harness scripts — the same modules `npm run test:integration` executes, not a copy.
const { prepare, OWNER_MARKER_TABLE, OWNER_MARKER_VALUE } = require("../../../scripts/integration/prepare");

const PROBE_TABLE = "_harness_lock_probe";

const sql = neonSql();

const CHILD_TABLE = "_harness_lock_probe_child";

beforeAll(async () => {
    await pgPool().query(`
        CREATE TABLE IF NOT EXISTS ${PROBE_TABLE} (
            id text PRIMARY KEY,
            n integer NOT NULL DEFAULT 0
        )
    `);
    await pgPool().query(`
        CREATE TABLE IF NOT EXISTS ${CHILD_TABLE} (
            id bigserial PRIMARY KEY,
            parent text NOT NULL
        )
    `);
});

beforeEach(async () => {
    await pgPool().query(`TRUNCATE TABLE ${PROBE_TABLE}, ${CHILD_TABLE}`);
    await pgPool().query(`INSERT INTO ${PROBE_TABLE} (id, n) VALUES ('a', 0), ('b', 0)`);
});

afterAll(async () => {
    await pgPool().query(`DROP TABLE IF EXISTS ${CHILD_TABLE}`);
    await pgPool().query(`DROP TABLE IF EXISTS ${PROBE_TABLE}`);
    await closeIntegrationConnections();
});

describe("concurrency helper", () => {
    it("observes a conflicting pair blocking, and names the blocker by pid", async () => {
        const observation = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query(`UPDATE ${PROBE_TABLE} SET n = n + 1 WHERE id = 'a'`);
            },
            contend: async () => {
                await sql`UPDATE _harness_lock_probe /* race:conflicting */ SET n = n + 100 WHERE id = 'a'`;
                return "done";
            },
            contenderMarker: "race:conflicting",
        });

        expect(observation.observedBlocked).toBe(true);
        expect(observation.waiterPids.length).toBeGreaterThan(0);
        expect(observation.holderPid).toBeGreaterThan(0);
        expect(observation.result).toBe("done");

        // Both writes landed: the contender was delayed, not discarded.
        const { rows } = await pgPool().query<{ n: number }>(`SELECT n FROM ${PROBE_TABLE} WHERE id = 'a'`);
        expect(rows[0].n).toBe(101);
    });

    it("observes an independent pair not blocking", async () => {
        const observation = await raceAgainstHeldLock({
            hold: async (holder) => {
                await holder.query(`UPDATE ${PROBE_TABLE} SET n = n + 1 WHERE id = 'a'`);
            },
            contend: async () => {
                await sql`UPDATE _harness_lock_probe /* race:independent */ SET n = n + 100 WHERE id = 'b'`;
                return "done";
            },
            contenderMarker: "race:independent",
            observeForMs: 1500,
        });

        expect(observation.observedBlocked).toBe(false);
        expect(observation.waiterPids).toEqual([]);

        // "Did not block" is only evidence if the statement actually ran. Asserting the resolved
        // value and the row it wrote is what separates this from a contender that failed
        // instantly — which also produces no waiters.
        expect(observation.result).toBe("done");
        const { rows } = await pgPool().query<{ n: number }>(`SELECT n FROM ${PROBE_TABLE} WHERE id = 'b'`);
        expect(rows[0].n).toBe(100);
    });

    it("rethrows a contender rejection instead of returning it as a result", async () => {
        // The failure mode this guards: a helper that catches the contender and casts the error to
        // `T` makes a broken statement look like a completed one. Every "observed not blocking"
        // gate in this milestone would then pass against SQL that never executed.
        await expect(
            raceAgainstHeldLock({
                hold: async (holder) => {
                    await holder.query(`UPDATE ${PROBE_TABLE} SET n = n + 1 WHERE id = 'a'`);
                },
                contend: async () => {
                    await sql`SELECT * FROM _harness_no_such_table /* race:rejecting */`;
                    return "done";
                },
                contenderMarker: "race:rejecting",
                observeForMs: 1500,
            })
        ).rejects.toThrow(/_harness_no_such_table/);

        // The holder was still released — a rethrow must not leak the open transaction.
        const { rows } = await pgPool().query<{ n: number }>(`SELECT n FROM ${PROBE_TABLE} WHERE id = 'a'`);
        expect(rows[0].n).toBe(1);
    });
});

describe("--fresh proves ownership before it destroys anything", () => {
    // The fixture stands in for the thing the old code destroyed: data living in a database that
    // merely shares the reserved name on an allowlisted endpoint. `--fresh` dropped first and read
    // the ownership marker afterwards, so the documented command erased it.
    const FIXTURE_TABLE = "_harness_fresh_fixture";

    /** Run `body` with the ownership marker replaced, restoring it whatever happens. */
    async function withMarkerReplacedBy(owner: string | null, body: () => Promise<void>): Promise<void> {
        await pgPool().query(`CREATE TABLE IF NOT EXISTS ${FIXTURE_TABLE} (id text PRIMARY KEY)`);
        await pgPool().query(`INSERT INTO ${FIXTURE_TABLE} (id) VALUES ('irreplaceable') ON CONFLICT DO NOTHING`);
        await pgPool().query(`DROP TABLE IF EXISTS ${OWNER_MARKER_TABLE}`);
        if (owner !== null) {
            await pgPool().query(`CREATE TABLE ${OWNER_MARKER_TABLE} (owner text PRIMARY KEY)`);
            await pgPool().query(`INSERT INTO ${OWNER_MARKER_TABLE} (owner) VALUES ($1)`, [owner]);
        }
        try {
            await body();
        } finally {
            // Leaving the marker wrong would break every later run, so restoration is unconditional.
            await pgPool().query(`DROP TABLE IF EXISTS ${OWNER_MARKER_TABLE}`);
            await pgPool().query(`CREATE TABLE ${OWNER_MARKER_TABLE} (owner text PRIMARY KEY)`);
            await pgPool().query(`INSERT INTO ${OWNER_MARKER_TABLE} (owner) VALUES ($1)`, [OWNER_MARKER_VALUE]);
            await pgPool().query(`DROP TABLE IF EXISTS ${FIXTURE_TABLE}`);
        }
    }

    async function fixtureSurvives(): Promise<boolean> {
        const { rows } = await pgPool().query<{ count: string }>(`SELECT count(*) AS count FROM ${FIXTURE_TABLE}`);
        return rows[0].count === "1";
    }

    it("refuses an unmarked database and leaves it intact", async () => {
        await withMarkerReplacedBy(null, async () => {
            await expect(prepare({ fresh: true })).rejects.toThrow(
                /--fresh refuses to drop a database that carries no harness ownership marker/
            );
            expect(await fixtureSurvives()).toBe(true);
        });
    });

    it("refuses a differently-owned database and leaves it intact", async () => {
        await withMarkerReplacedBy("someone-elses-harness", async () => {
            await expect(prepare({ fresh: true })).rejects.toThrow(
                /records owner 'someone-elses-harness', not this harness/
            );
            expect(await fixtureSurvives()).toBe(true);
        });
    });
});

describe("Neon HTTP driver semantics the plan depends on", () => {
    it("auto-commits per call, so a standalone SELECT ... FOR UPDATE holds no lock", async () => {
        // If this ever started blocking, the "two connections and a JS barrier" shortcut would
        // become viable — and several chunks' statement shapes could be simplified. It does not.
        await sql`SELECT * FROM _harness_lock_probe WHERE id = 'a' FOR UPDATE`;

        const other = await pgClient();
        try {
            await other.query("BEGIN");
            const locked = await other.query(
                `SELECT n FROM ${PROBE_TABLE} WHERE id = 'a' FOR UPDATE NOWAIT`
            );
            expect(locked.rows[0].n).toBe(0);
            await other.query("COMMIT");
        } finally {
            await other.end();
        }
    });

    it("fires a batch's second element even when the first matched nothing", async () => {
        // The dangerous case, stated as an outcome rather than a type check. Locked decision 1
        // says batch elements cannot read one another's RETURNING; the consequence that matters is
        // that a "gated" write expressed as a batch is not gated at all — the loser's second
        // element still commits. This is why C6, C14 and C21 must use data-modifying CTEs.
        const [claimed, dependent] = await sql.transaction([
            // Matches zero rows: `n` is 0, not 999.
            sql`UPDATE _harness_lock_probe SET n = 7 WHERE id = 'a' AND n = 999 RETURNING id`,
            sql`INSERT INTO _harness_lock_probe_child (parent) VALUES ('a') RETURNING parent`,
        ]);

        expect(claimed).toHaveLength(0);
        // The write the first element was supposed to gate happened anyway.
        expect(dependent).toHaveLength(1);
        const { rows } = await pgPool().query<{ count: string }>(
            `SELECT count(*) AS count FROM ${CHILD_TABLE}`
        );
        expect(rows[0].count).toBe("1");
    });

    it("lets a conditional UPDATE arm gate an INSERT, and fires nothing for the loser", async () => {
        // This is the exact shape C6, C14 and C21 prescribe: the decisive transition is one arm,
        // the dependent write is SELECT-gated on that arm's RETURNING, and both commit together.
        const winner = await sql`
            WITH claimed AS (
                UPDATE _harness_lock_probe SET n = n + 1 WHERE id = 'a' AND n = 0 RETURNING id
            )
            INSERT INTO _harness_lock_probe_child (parent)
            SELECT id FROM claimed
            RETURNING parent
        `;
        expect(winner).toHaveLength(1);

        // Re-running is the loser's path: the guarded arm matches zero rows, so the INSERT's
        // SELECT is empty and nothing is written. A `sql.transaction` batch could not express
        // this — its second element would insert unconditionally.
        const loser = await sql`
            WITH claimed AS (
                UPDATE _harness_lock_probe SET n = n + 1 WHERE id = 'a' AND n = 0 RETURNING id
            )
            INSERT INTO _harness_lock_probe_child (parent)
            SELECT id FROM claimed
            RETURNING parent
        `;
        expect(loser).toHaveLength(0);

        const { rows: children } = await pgPool().query<{ count: string }>(
            `SELECT count(*) AS count FROM _harness_lock_probe_child`
        );
        expect(children[0].count).toBe("1");
    });

    it("will not let one statement update the same row twice, gated arm or not", async () => {
        // Postgres evaluates every arm of a data-modifying statement against one snapshot and
        // refuses to touch a row a *different* arm of the same statement already modified. The
        // second UPDATE below silently affects nothing — no error, no rows.
        //
        // Encoded rather than worked around: the CTE shapes this milestone prescribes must gate a
        // write to a *different* row or table, never a second write to the row they just claimed.
        // A chunk that reached for `WITH claimed AS (UPDATE t ...) UPDATE t ...` would look correct
        // in review and do nothing in production.
        const rows = await sql`
            WITH claimed AS (
                UPDATE _harness_lock_probe SET n = n + 1 WHERE id = 'a' AND n = 0 RETURNING id
            )
            UPDATE _harness_lock_probe SET n = 42 WHERE id IN (SELECT id FROM claimed) RETURNING id, n
        `;
        expect(rows).toHaveLength(0);

        const { rows: after } = await pgPool().query<{ n: number }>(
            `SELECT n FROM ${PROBE_TABLE} WHERE id = 'a'`
        );
        // Only the CTE arm's increment landed; the outer UPDATE was a no-op.
        expect(after[0].n).toBe(1);
    });
});
