/**
 * M11-1 C0 — the guard that runs no matter how Jest was started.
 *
 * `scripts/integration/run.js` validates the target before spawning Jest, but nothing forced anyone
 * to go through it. `jest --config jest.integration.config.js` with two environment variables set by
 * hand reached the suites directly, and the in-process check in `helpers/setup.ts` compared only the
 * *database name* — not the allowlisted host, not the ownership marker. The suites then issue direct
 * destructive SQL (`TRUNCATE`, `DELETE`, `DROP TABLE`) without going through the guarded truncation
 * helper, so any database anywhere that happened to be named `safemolt_integration` was reachable.
 *
 * This file closes that. Jest runs `globalSetup` before any suite, any `setupFilesAfterEach`, and
 * any worker fork, and it re-derives the permitted target from the **tracked allowlist file** rather
 * than trusting what the environment says. The three things it proves, in order and before the first
 * test statement runs:
 *
 *   1. the endpoint in POSTGRES_URL is the one the allowlist calls disposable — the whole hostname,
 *      and with no connection-redirecting query parameter that would send `pg` somewhere else;
 *   2. the connection really lands in the reserved database (`current_database()`, asked of the
 *      server, not parsed out of a string);
 *   3. that database carries this harness's ownership marker.
 *
 * Absence of positive proof is a refusal. A run that cannot prove all three does not start.
 */
const { Client } = require("pg");
const { normalisedHost, assertNoRedirectingParams, describeTarget } = require("./guard");
const { OWNER_MARKER_TABLE, OWNER_MARKER_VALUE } = require("./prepare");
const { acquireHarnessLock, guardedTarget, DIRECT_RUN_LOCK } = require("./lock");

function fail(message) {
  throw new Error(
    `[integration] refusing to start the suite: ${message}\n` +
      `Run it with \`npm run test:integration\`, which provisions and proves the target first.`
  );
}

module.exports = async function globalSetup(globalConfig) {
  // Workers are OS child processes. This function takes the harness lock in the coordinator, and a
  // worker would neither inherit it nor take its own — so the coordinator would hold the key while
  // separate processes ran the destructive SQL, which is exactly the orphaned-child ownership
  // problem this design exists to avoid. `maxWorkers: 1` in the config makes that the default;
  // this refuses a command line that overrides it, because the config alone is only a default.
  if (globalConfig && globalConfig.maxWorkers !== 1) {
    fail(
      `Jest is configured for ${globalConfig.maxWorkers} workers. The integration suite must run in a\n` +
        `single process: the harness lock is held here, and worker processes would neither see it nor\n` +
        `own one. Use \`npm run test:integration\`, or pass --runInBand.`
    );
  }

  // Derived from the tracked allowlist, never from what the caller set. If INTEGRATION_DATABASE_URL
  // is missing or names a host no human marked disposable, this throws and the suite never starts.
  // Resolved once and reused for the lock below, so the target that is proven here is the target
  // that gets locked — two resolutions could straddle a `.env.local` or allowlist edit.
  const target = guardedTarget();

  const supplied = process.env.POSTGRES_URL;
  if (!supplied) fail("POSTGRES_URL is unset inside the test process");

  let url;
  try {
    url = new URL(supplied);
  } catch {
    return fail("POSTGRES_URL is not a valid URL");
  }
  assertNoRedirectingParams(url, "POSTGRES_URL");

  const suppliedEndpoint = normalisedHost(url.hostname);
  if (suppliedEndpoint !== target.endpointId) {
    fail(
      `POSTGRES_URL points at '${suppliedEndpoint}', but the allowlisted disposable endpoint is '${target.endpointId}'`
    );
  }

  const suppliedDatabase = url.pathname.replace(/^\//, "");
  if (suppliedDatabase !== target.reservedDatabase) {
    fail(`POSTGRES_URL names database '${suppliedDatabase}', but the reserved harness database is '${target.reservedDatabase}'`);
  }

  const client = new Client({ connectionString: supplied });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT current_database() AS db");
    if (rows[0].db !== target.reservedDatabase) {
      fail(`connected to '${rows[0].db}' but the reserved harness database is '${target.reservedDatabase}'`);
    }

    const { rows: present } = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [
      `public.${OWNER_MARKER_TABLE}`,
    ]);
    if (!present[0].present) {
      fail(`'${target.reservedDatabase}' carries no harness ownership marker — it is not this harness's database`);
    }
    const { rows: marker } = await client.query(`SELECT owner FROM ${OWNER_MARKER_TABLE} LIMIT 1`);
    if (marker[0]?.owner !== OWNER_MARKER_VALUE) {
      fail(`'${target.reservedDatabase}' records owner '${marker[0]?.owner ?? "(none)"}', not this harness`);
    }
  } finally {
    await client.end();
  }

  // Only now, with the target proven, is the in-process invariant published. Setting it here rather
  // than requiring the wrapper to pass it means the value the suites check is one this file
  // verified, not one a caller asserted.
  process.env.INTEGRATION_RESERVED_DATABASE = target.reservedDatabase;

  console.log(`[integration] target proven: ${describeTarget(target.targetUrl)} (endpoint ${target.endpointId})`);

  // `jest --config jest.integration.config.js` is a supported way in — this file exists precisely
  // because nothing forces anyone through the wrapper. Proving the target was never enough on its
  // own: the suites then delete by fixture prefix, so a direct run beside a wrapped run corrupts
  // both. It takes the same lock, and `globalTeardown` releases it.
  //
  // Owned here rather than inherited from the wrapper, and taken unconditionally. A wrapper that
  // held one lock across the whole run could not survive SIGKILL: its session dies, its lock is
  // released, and this process would keep issuing destructive SQL on the strength of a claim about
  // a parent that is already gone. Ownership is not a claim. `run.js` releases before spawning Jest
  // for exactly that reason, so there is no parent to queue behind — and if another run took the
  // lock in the gap, this one waits for it here, before the first suite, which is the only place
  // waiting costs nothing.
  //
  // `globalTeardown` releases it, and fails the run if it was lost along the way.
  globalThis[DIRECT_RUN_LOCK] = await acquireHarnessLock({ target });
};
