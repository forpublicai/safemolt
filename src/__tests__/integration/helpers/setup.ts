/**
 * M11-1 C0 — per-worker re-assertion, inside the test process.
 *
 * The *proving* happens in `scripts/integration/jest-global-setup.js`, which runs before any worker
 * exists and checks the allowlisted endpoint, the live `current_database()`, and the ownership
 * marker against the tracked allowlist file. This file is deliberately not that guard, and an
 * earlier version of this comment claimed more than it did: comparing a database *name* proves only
 * that something is called `safemolt_integration`, which is exactly the property an unrelated
 * database can also have.
 *
 * What it is still worth doing here: `next/jest` loads `.env.*` files into each worker. It does not
 * overwrite variables that are already set, so the scrubbed POSTGRES_URL should survive — and this
 * asserts that rather than assuming it, in every worker, after that loading has happened.
 */
const reserved = process.env.INTEGRATION_RESERVED_DATABASE;
const connection = process.env.POSTGRES_URL;

if (!reserved) {
    throw new Error(
        "[integration] INTEGRATION_RESERVED_DATABASE is unset — globalSetup did not run. Use `npm run test:integration`."
    );
}

if (!connection) {
    throw new Error("[integration] POSTGRES_URL is unset inside the test process — the harness wrapper did not run.");
}

const databaseName = new URL(connection).pathname.replace(/^\//, "");
if (databaseName !== reserved) {
    throw new Error(
        `[integration] POSTGRES_URL names database '${databaseName}' but the reserved harness database is '${reserved}'. Refusing to run.`
    );
}

/**
 * The harness lock has to be held by *this* process, and this is the only file that runs in it.
 *
 * `globalSetup` acquires the lock in the coordinator and Jest carries the depth into each test
 * environment by copying `process`. A **worker** is a separate OS process and receives no copy, so
 * it would run the suites' destructive SQL while the lock lived somewhere else entirely — the
 * orphaned-child ownership problem the design exists to avoid. The config pins `maxWorkers: 1` and
 * `globalSetup` refuses any other setting, but both of those are decided before a worker exists,
 * and a `--globalSetup=...` override replaces the file that makes them. This assertion is inside
 * the process that issues the SQL, so it holds whatever the command line said.
 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { harnessLockIsHeld } = require("../../../../scripts/integration/lock");
if (!harnessLockIsHeld()) {
    throw new Error(
        "[integration] this process does not hold the harness lock — it is a Jest worker, or global setup was replaced.\n" +
            "The suites delete by fixture prefix, so running unlocked corrupts any concurrent run.\n" +
            "Use `npm run test:integration`, which runs the suite in a single locked process."
    );
}

export {};
