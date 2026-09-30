/**
 * `[integration]` — the harness lock actually excludes a second run.
 *
 * This claim cannot be mocked. It rests on what two real sessions do to one advisory key, and the
 * defect it guards against is precisely a lock that *looks* taken and excludes nobody: measured
 * against the live branch, two clients on Neon's `-pooler` host BOTH acquired the same key, with
 * `pg_backend_pid()` stable in both, so every single-connection self-check passes in the broken
 * case. Only a second connection tells the two apart.
 *
 * **Every test here uses an injected key, never `HARNESS_LOCK_KEY`.** The run executing this file
 * holds the real key already — `jest-global-setup.js` acquired it before the first suite — so
 * acquiring it here would queue behind this very run and wait until the timeout.
 */
import { Client } from "pg";
import {
    acquireHarnessLock,
    guardedTarget,
    harnessLockIsHeld,
    isGuardedTarget,
    lockConnectionUrl,
    withHarnessLock,
} from "../../../scripts/integration/lock";
import { resolveIntegrationTarget } from "../../../scripts/integration/guard";

const target = guardedTarget();

/** Distinct per test, so nothing here contends with anything else — including a parallel worker. */
let nextKey = 0;
function testKey() {
    return { classid: 0x7e57_0000 | 0, objid: 0x1000 + (nextKey += 1) };
}

async function holdsKey(key: { classid: number; objid: number }): Promise<boolean> {
    const client = new Client({ connectionString: lockConnectionUrl(target) });
    await client.connect();
    try {
        const { rows } = await client.query(
            `SELECT count(*)::int AS held
               FROM pg_locks
              WHERE locktype = 'advisory' AND granted
                AND classid = $1::oid AND objid = $2::oid AND objsubid = 2`,
            [key.classid, key.objid]
        );
        return rows[0].held > 0;
    } finally {
        await client.end();
    }
}

describe("the harness lock", () => {
    it("stops a second acquirer while the first holds it, and admits it once released", async () => {
        const key = testKey();
        const first = await acquireHarnessLock({ target, key, log: () => {} });

        try {
            // Short timeout: this asserts the second acquirer does NOT get in, so it must give up
            // rather than wait out the real 45-minute window.
            await expect(
                acquireHarnessLock({ target, key, timeoutMs: 1500, log: () => {} })
            ).rejects.toThrow(/gave up waiting for the integration lock/);
        } finally {
            await first.release();
        }

        // The release is the other half of the claim: a lock that never let go would serialize
        // everything into a permanent stall rather than a queue.
        const second = await acquireHarnessLock({ target, key, timeoutMs: 5000, log: () => {} });
        await second.release();
    });

    it("names the holder in the message a waiting run is shown", async () => {
        const key = testKey();
        const first = await acquireHarnessLock({ target, key, log: () => {} });
        const lines: string[] = [];
        try {
            await acquireHarnessLock({ target, key, timeoutMs: 1200, log: (line) => lines.push(line) }).catch(
                () => {}
            );
        } finally {
            await first.release();
        }

        // Without this a blocked developer sees a hang and no reason for it.
        expect(lines.join("\n")).toMatch(/waiting for the integration lock — held by .*pid=\d+/);
    });

    it("releases the key on the server, not just in this process", async () => {
        const key = testKey();
        const lock = await acquireHarnessLock({ target, key, log: () => {} });
        expect(await holdsKey(key)).toBe(true);
        await lock.release();
        expect(await holdsKey(key)).toBe(false);
    });

    it("survives a second release without throwing", async () => {
        const key = testKey();
        const lock = await acquireHarnessLock({ target, key, log: () => {} });
        await lock.release();
        await expect(lock.release()).resolves.toBeUndefined();
    });

    it("still reports itself held at the end of a run, asked of the server", async () => {
        // The check `withHarnessLock` makes before it will vouch for a run's results. It has to
        // work without the event loop having been free, so it queries rather than inferring.
        const key = testKey();
        const lock = await acquireHarnessLock({ target, key, log: () => {} });
        expect(await lock.stillHeld()).toBe(true);
        await lock.release();
        expect(await lock.stillHeld()).toBe(false);
    });

    it("takes the lock on a connection that genuinely excludes — the pooler check", async () => {
        // The regression this whole module exists for. If someone points the lock at the pooled
        // host again, a second connection can take the same key and `acquireHarnessLock` must
        // refuse rather than hand back a lock that serializes nothing.
        const key = testKey();
        const lock = await acquireHarnessLock({ target, key, log: () => {} });
        try {
            const rival = new Client({ connectionString: lockConnectionUrl(target) });
            await rival.connect();
            try {
                const { rows } = await rival.query("SELECT pg_try_advisory_lock($1::int4, $2::int4) AS acquired", [
                    key.classid,
                    key.objid,
                ]);
                expect(rows[0].acquired).toBe(false);
            } finally {
                await rival.end();
            }
        } finally {
            await lock.release();
        }
    });
});

/**
 * Ownership is this process's own state, not a claim it inherited.
 *
 * The wrapper cannot tell Jest "you are covered": a claim passed to a child describes a process
 * that may already be gone — SIGKILL the wrapper and its session, and therefore its lock, dies
 * while the child carries on. So the process doing the destructive work holds its own lock, and
 * `harnessLockIsHeld` reports only on that.
 */
describe("holding the lock is per-process state", () => {
    it("sees the lock global setup took, from a different module registry", async () => {
        // Jest hands every test file its own module registry, so `lock.js` here is a different
        // instance from the one `globalSetup` acquired through. Module-level state would report
        // "not held" while the process demonstrably holds the key — and `prepare()`, which refuses
        // to provision unlocked, would then refuse inside a run that *is* locked. Recording the
        // depth on `process` is what makes every registry agree.
        expect(harnessLockIsHeld()).toBe(true);
    });

    it("stays held across an extra acquire and its release", async () => {
        const key = testKey();
        const lock = await acquireHarnessLock({ target, key, log: () => {} });
        expect(harnessLockIsHeld()).toBe(true);
        await lock.release();
        // Still true: this run's own lock, taken by global setup, outlives the nested one.
        expect(harnessLockIsHeld()).toBe(true);
    });

    it("refuses a nested wrapper instead of queueing behind itself", async () => {
        // This run already holds the real key, so a wrapper started here would wait out the full
        // timeout on its own process's lock and then report it as contention from another run.
        await expect(withHarnessLock(async () => undefined, { target })).rejects.toThrow(
            /already holds the integration lock/
        );
    });
});

describe("the guarded target", () => {
    it("brands what it resolved, so provisioning can tell it from a caller's object", () => {
        // `prepare()` trusts a target instead of re-resolving, which closed a lock-one/provision-
        // another race. The brand is what stops that trust extending to an arbitrary object naming
        // a database the allowlist never approved.
        expect(isGuardedTarget(target)).toBe(true);
        expect(isGuardedTarget({ ...resolveIntegrationTarget() })).toBe(false);
        expect(isGuardedTarget(undefined)).toBe(false);
    });

    it("is frozen, so a holder cannot be repointed after it was locked", () => {
        expect(Object.isFrozen(target)).toBe(true);
    });
});
