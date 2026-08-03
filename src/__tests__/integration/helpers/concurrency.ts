/**
 * M11-1 C0 — a concurrency helper that can actually hold a lock.
 *
 * The obvious implementation does not work over the Neon HTTP driver. Every `sql``` call is its
 * own connection and **auto-commits**, so a standalone `SELECT ... FOR UPDATE` has already
 * released its lock by the time a JavaScript barrier is reached. A race test written that way
 * observes no contention and goes green whether or not the fix works — the worst possible outcome
 * for a dozen gates in this milestone. This repo already documents the same constraint at
 * `src/lib/store/groups/db.ts`.
 *
 * So the blocking side holds a *real* lock on the *same object* the application statement
 * contends on, inside an open `pg` transaction, and a third connection reports which side blocked
 * via `pg_blocking_pids()`. Advisory locks cannot substitute: `pg_advisory_lock` blocks only other
 * callers requesting the same advisory key and does not block an ordinary `UPDATE` at all, so a
 * harness built on them would certify itself while detecting nothing. Advisory locks may still
 * sequence the harness's own setup, which is the only role they have here.
 *
 * Wall-clock ordering is never the assertion basis: it cannot distinguish "blocked" from "was
 * slower". `observedBlocked` comes from the catalog or it is false.
 */
import type { Client } from "pg";
import { pgClient, pgPool } from "./db";

export interface ContentionResult<T> {
    /** True only if an observer saw the contender waiting specifically on the lock holder. */
    observedBlocked: boolean;
    /** Backend pid of the connection that held the lock. */
    holderPid: number;
    /** Backend pids observed waiting on `holderPid`. */
    waiterPids: number[];
    /**
     * The CURRENT QUERY TEXT of each observed waiter.
     *
     * Assert on this when "something blocked" is too weak to distinguish the fix from the defect.
     * A marker comment can be pasted onto any statement, so a gate that only checks the marker
     * passes against a rewrite that blocks for the wrong reason — which is exactly what M11-1b D1's
     * finding 6 caught in its own lock test.
     */
    waiterQueries: string[];
    /**
     * What the contending callback **resolved** to. A rejection never reaches here — it is
     * rethrown. An earlier version returned the error cast to `T`, which meant a contender that
     * failed instantly satisfied both "did not block" and "produced a result", so an assertion pair
     * of `observedBlocked === false` plus nothing else went green against a statement that never
     * ran. Never let a race helper turn a failure into evidence.
     */
    result: T;
    /** Diagnostic only. Never assert on this. */
    elapsedMs: number;
}

export interface RaceOptions<T> {
    /** Acquire the production lock. Runs inside an open transaction on a dedicated `pg` session. */
    hold: (holder: Client) => Promise<void>;
    /** The racing statement, normally issued through the Neon HTTP driver. */
    contend: () => Promise<T>;
    /**
     * A string that appears verbatim in the contending statement — normally an SQL comment such as
     * `/* race:c4-first-auth *\/`. Supplying it is what lets the observer prove the backend it saw
     * blocked is the one under test.
     */
    contenderMarker?: string;
    /** How long to watch for contention before releasing the lock. */
    observeForMs?: number;
    pollIntervalMs?: number;
}

async function backendPid(client: Client): Promise<number> {
    const { rows } = await client.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    return rows[0].pid;
}

/**
 * Who, right now, is waiting on `holderPid`? Sampled from a third connection.
 *
 * When `marker` is supplied, only backends whose *current query text* contains it count. Without
 * that, any unrelated backend blocked by the holder — including one from a concurrent harness run
 * against the same shared database — would satisfy the assertion and make a race look detected
 * when the statement under test never blocked at all.
 */
export async function waitersOn(
    holderPid: number,
    marker?: string
): Promise<Array<{ pid: number; query: string }>> {
    const { rows } = await pgPool().query<{ pid: number; blockers: number[]; query: string }>(
        `SELECT pid, pg_blocking_pids(pid) AS blockers, query
         FROM pg_stat_activity
         WHERE datname = current_database()
           AND pid <> pg_backend_pid()
           AND cardinality(pg_blocking_pids(pid)) > 0`
    );
    return rows
        .filter((row) => row.blockers.includes(holderPid))
        .filter((row) => (marker ? String(row.query ?? "").includes(marker) : true))
        .map((row) => ({ pid: row.pid, query: String(row.query ?? "") }));
}

/**
 * Poll until a backend blocked by `holderPid` matches `marker`, or the deadline passes.
 *
 * For the tests that must act only once the statement under test is genuinely waiting — a sleep
 * would make them flaky in one direction and vacuous in the other.
 */
export async function waitForWaiter(
    holderPid: number,
    marker: string,
    timeoutMs = 5000,
    pollIntervalMs = 25
): Promise<boolean> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if ((await waitersOn(holderPid, marker)).length > 0) return true;
        await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
    }
    return false;
}

/** Backend pid of an open `pg` client, for callers driving their own hold. */
export async function pidOf(client: Client): Promise<number> {
    return backendPid(client);
}

/**
 * Await the contender, keeping "resolved" and "rejected" distinguishable.
 *
 * Separated out so the caller cannot accidentally collapse the two — which is the defect this
 * helper's history is about.
 */
async function settleContender<T>(
    contention: Promise<T> | null
): Promise<{ ok: true; value: T } | { ok: false; error: unknown }> {
    if (!contention) return { ok: true, value: undefined as T };
    try {
        return { ok: true, value: await contention };
    } catch (error) {
        return { ok: false, error };
    }
}

/**
 * Hold a real lock, race a statement against it, and report whether the statement blocked.
 *
 * The lock is always released, and the contender is always awaited, even when the observation
 * loop or the hold callback throws — a leaked open transaction would wedge every later test.
 *
 * A contender that **rejects** is a failed race, not an outcome: its error is rethrown once the
 * holder has been released. Callers that need to classify expected failures (two writers racing a
 * unique index, say) want `runConcurrently`, which reports each side's outcome; this helper exists
 * to prove one statement blocked on another, and a statement that errored out proved nothing.
 */
export async function raceAgainstHeldLock<T>(options: RaceOptions<T>): Promise<ContentionResult<T>> {
    const observeForMs = options.observeForMs ?? 3000;
    const pollIntervalMs = options.pollIntervalMs ?? 25;

    const holder = await pgClient();
    let holderPid = -1;
    let contention: Promise<T> | null = null;
    let settled = false;
    let observedBlocked = false;
    let waiters: Array<{ pid: number; query: string }> = [];
    let failure: unknown = null;
    const startedAt = Date.now();

    try {
        holderPid = await backendPid(holder);
        await holder.query("BEGIN");
        await options.hold(holder);

        contention = options.contend();
        // Swallow here only so an early rejection cannot become an unhandled rejection while we
        // are still polling; the real outcome is re-awaited below.
        contention.then(
            () => {
                settled = true;
            },
            () => {
                settled = true;
            }
        );

        const deadline = Date.now() + observeForMs;
        while (Date.now() < deadline) {
            waiters = await waitersOn(holderPid, options.contenderMarker);
            if (waiters.length > 0) {
                observedBlocked = true;
                break;
            }
            if (settled) break;
            await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
        }
        failure = null;
    } catch (err) {
        // Committing a half-set-up hold would leave whatever the `hold` callback managed to write
        // behind, contaminating every later race. On failure the transaction is abandoned.
        failure = err;
    } finally {
        try {
            await holder.query(failure ? "ROLLBACK" : "COMMIT");
        } catch {
            /* the session is already gone; nothing left to release */
        }
        await holder.end();
    }

    // Awaited before rethrowing, always. Letting the contender finish in the background after the
    // test has failed is exactly how one failure poisons the next test's observations.
    const outcome = await settleContender(contention);

    // Hold-side failure first: it explains a contender rejection that followed from it.
    if (failure) throw failure;
    // A rejected contender is never returned as a value. Casting the error to `T` — what this used
    // to do — makes "the statement failed instantly" indistinguishable from "the statement ran and
    // did not block", and every `observedBlocked === false` assertion then passes for free.
    if (!outcome.ok) throw outcome.error;

    return {
        observedBlocked,
        holderPid,
        waiterPids: waiters.map((waiter) => waiter.pid),
        waiterQueries: waiters.map((waiter) => waiter.query),
        result: outcome.value,
        elapsedMs: Date.now() - startedAt,
    };
}

/**
 * Run callbacks concurrently and classify each outcome.
 *
 * Used by the "exactly one winner" gates, where the assertion is on how many calls succeeded and
 * what the database holds afterwards — never on which one finished first.
 */
export async function runConcurrently<T>(
    tasks: Array<() => Promise<T>>
): Promise<Array<{ ok: true; value: T } | { ok: false; error: unknown }>> {
    return Promise.all(
        tasks.map((task) =>
            task().then(
                (value) => ({ ok: true as const, value }),
                (error) => ({ ok: false as const, error })
            )
        )
    );
}

/**
 * The rejections in a `runConcurrently` result, described well enough to act on.
 *
 * Assert with this rather than with `outcomes.every((o) => o.ok)`: that form reports only
 * `expected true, received false`, and the error it is asserting the absence of is exactly the
 * thing a reader then has to reproduce to see. A `40P01` deadlock in `createComment` reached this
 * suite as an intermittent boolean and cost a full investigation to name; `expect(rejections(…))
 * .toEqual([])` would have printed `deadlock detected` on the first failure.
 *
 * The SQLSTATE leads, because for these gates it is the whole diagnosis: `40P01` is a lock-order
 * defect in the statement under test, `23505` a shape defect, and a transport error is neither.
 *
 * Postgres's `detail` is deliberately NOT included, even though it is the most informative field
 * on a constraint violation. It embeds the conflicting values — `Key (api_key)=(…) already
 * exists` — and this string is printed by a failing assertion into whatever holds the CI log. The
 * constraint and table names identify the same defect and name nothing. Both drivers this harness
 * uses (`pg`'s `DatabaseError`, Neon's `NeonDbError`) carry all three fields.
 */
export function rejections<T>(
    outcomes: Array<{ ok: true; value: T } | { ok: false; error: unknown }>
): string[] {
    return outcomes
        .filter((outcome): outcome is { ok: false; error: unknown } => !outcome.ok)
        .map(({ error }) => {
            if (!error || typeof error !== "object") return String(error);
            const e = error as { code?: unknown; message?: unknown; constraint?: unknown; table?: unknown };
            const code = e.code === undefined ? "" : `[${String(e.code)}] `;
            const at = [e.table, e.constraint].filter((part) => part !== undefined).map(String);
            return `${code}${String(e.message ?? error)}${at.length ? ` (${at.join(".")})` : ""}`;
        });
}
