/**
 * @jest-environment node
 *
 * The parts of the integration harness lock that can be proven without a database.
 *
 * `node`, not the default jsdom: `lock.js` loads `pg`, which needs `TextEncoder`.
 *
 * The lock's whole reason for existing is a measured fact: over Neon's `-pooler` host, two clients
 * BOTH acquire the same advisory key, so a lock built on the configured URL serializes nothing.
 * `lockConnectionUrl` is what keeps the lock off that host, which makes it the load-bearing piece
 * of pure logic here. The mutual-exclusion claim itself needs a real server and is asserted in
 * `src/__tests__/integration/harness-lock.test.ts`.
 */
import { HARNESS_LOCK_KEY, lockConnectionUrl, lockIdentity, readTimeoutMs } from "../../../scripts/integration/lock";

const POOLED = {
    endpointId: "ep-example-1234.eu-west-2.aws.neon.tech",
    reservedDatabase: "safemolt_integration",
    targetUrl: "postgres://user:secret@ep-example-1234-pooler.eu-west-2.aws.neon.tech/safemolt_integration?sslmode=require",
    maintenanceUrl: "postgres://user:secret@ep-example-1234-pooler.eu-west-2.aws.neon.tech/postgres?sslmode=require",
};

describe("lockConnectionUrl", () => {
    it("moves the lock off the pooled host and onto the allowlisted endpoint", () => {
        // The one assertion that matters. A lock on the `-pooler` host is granted to every caller.
        const url = new URL(lockConnectionUrl(POOLED));
        expect(url.hostname).toBe(POOLED.endpointId);
        expect(url.hostname).not.toContain("-pooler");
    });

    it("locks in the maintenance database, never the reserved one", () => {
        // `--fresh` terminates every session on the reserved database and drops it. A lock held
        // there would be destroyed by the run it exists to block.
        expect(new URL(lockConnectionUrl(POOLED)).pathname).toBe("/postgres");
    });

    it("keeps the credentials and TLS mode of the target it was derived from", () => {
        const url = new URL(lockConnectionUrl(POOLED));
        expect(url.username).toBe("user");
        expect(url.password).toBe("secret");
        expect(url.searchParams.get("sslmode")).toBe("require");
    });

    it("is a no-op on a host that is already direct", () => {
        const direct = {
            ...POOLED,
            maintenanceUrl: "postgres://user:secret@ep-example-1234.eu-west-2.aws.neon.tech/postgres",
        };
        expect(new URL(lockConnectionUrl(direct)).hostname).toBe(POOLED.endpointId);
    });

    it("strips parameters that would change how the lock session behaves or is identified", () => {
        // `lock_timeout` decides how long a waiting run waits; `application_name` is how a waiting
        // run names the holder. Neither may come from the connection string.
        const hostile = {
            ...POOLED,
            maintenanceUrl:
                "postgres://user:secret@ep-example-1234-pooler.eu-west-2.aws.neon.tech/postgres" +
                "?sslmode=require&application_name=impostor&lock_timeout=1&idle_session_timeout=5&options=-c%20lock_timeout%3D1",
        };
        const url = new URL(lockConnectionUrl(hostile));
        expect(url.searchParams.get("application_name")).toBeNull();
        expect(url.searchParams.get("lock_timeout")).toBeNull();
        expect(url.searchParams.get("idle_session_timeout")).toBeNull();
        expect(url.searchParams.get("options")).toBeNull();
        expect(url.searchParams.get("sslmode")).toBe("require");
    });

    it("refuses a target carrying a connection-redirecting parameter", () => {
        const redirecting = {
            ...POOLED,
            maintenanceUrl: "postgres://user:secret@ep-example-1234-pooler.eu-west-2.aws.neon.tech/postgres?host=elsewhere",
        };
        expect(() => lockConnectionUrl(redirecting)).toThrow(/redirecting parameter/);
    });
});

describe("the lock key", () => {
    it("is a fixed pair inside int4, so `pg_advisory_lock(int4, int4)` accepts it", () => {
        // A hash of the database name would have needed signed conversion: FNV-1a of
        // `safemolt_integration` is 3062375269, which is above int4's maximum and is rejected.
        for (const part of [HARNESS_LOCK_KEY.classid, HARNESS_LOCK_KEY.objid]) {
            expect(Number.isInteger(part)).toBe(true);
            expect(part).toBeGreaterThan(0);
            expect(part).toBeLessThanOrEqual(2147483647);
        }
    });

    it("is one shared key, because every run of this harness must contend", () => {
        expect(HARNESS_LOCK_KEY).toEqual({ classid: 0x53414645, objid: 0x4d4f4c54 });
    });
});

describe("lockIdentity", () => {
    it("fits Postgres's 63-byte application_name and names the process", () => {
        const identity = lockIdentity();
        expect(identity.length).toBeLessThanOrEqual(63);
        // It is what a waiting run prints, so the pid has to survive truncation — that is the part
        // someone uses to find the run they are queued behind.
        expect(identity).toContain(`pid=${process.pid}`);
    });
});

describe("readTimeoutMs", () => {
    const original = process.env.INTEGRATION_LOCK_TIMEOUT_MS;
    afterEach(() => {
        if (original === undefined) delete process.env.INTEGRATION_LOCK_TIMEOUT_MS;
        else process.env.INTEGRATION_LOCK_TIMEOUT_MS = original;
    });

    it("defaults to a window that outlasts a full run", () => {
        delete process.env.INTEGRATION_LOCK_TIMEOUT_MS;
        // A full suite takes ~13 minutes, so the default has to admit several queued runs before
        // it starts failing people for waiting.
        expect(readTimeoutMs()).toBeGreaterThanOrEqual(30 * 60 * 1000);
    });

    it("accepts an explicit override", () => {
        process.env.INTEGRATION_LOCK_TIMEOUT_MS = "1500";
        expect(readTimeoutMs()).toBe(1500);
    });

    it.each(["0", "-1", "abc", "NaN"])("refuses '%s' rather than waiting for a nonsense duration", (value) => {
        process.env.INTEGRATION_LOCK_TIMEOUT_MS = value;
        expect(() => readTimeoutMs()).toThrow(/positive number of milliseconds/);
    });

    it("falls back to the default when the variable is present but empty", () => {
        process.env.INTEGRATION_LOCK_TIMEOUT_MS = "";
        expect(readTimeoutMs()).toBeGreaterThanOrEqual(30 * 60 * 1000);
    });
});
