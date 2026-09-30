/**
 * Serialize integration runs against the shared reserved database.
 *
 * Two concurrent `npm run test:integration` runs corrupt each other. They share one database and
 * the same fixture prefixes (`c16_`, `c21_`, `c25_`), and the suites delete by prefix in
 * `beforeEach` — so each run deletes the other's rows mid-test. The damage does not look like
 * contention; it looks like application defects: `*_fkey` violations raised in `beforeAll`, race
 * gates that observe no contention because their post was deleted, and migration gates where an
 * expected refusal does not happen because the other run already repaired the fixture. Each one
 * costs an investigation before anyone suspects a second run.
 *
 * So a run takes a lock and a second run waits for it.
 *
 * **The lock is held by the process doing the destructive work, and nothing is inherited.** The
 * wrapper holds it across `prepare()`, releases it, and Jest's own `globalSetup` takes a fresh one
 * before any suite runs. The tempting alternative — the wrapper holds one lock for the whole run
 * and tells Jest it may proceed — cannot survive SIGKILL: the wrapper's session dies with it, its
 * lock is released, and the orphaned Jest keeps issuing destructive SQL believing itself covered.
 * A claim passed to a child is only ever a claim about a process that may already be gone. Owning
 * the lock is not. The cost is a gap between the wrapper's release and Jest's acquire, in which
 * another run may win the lock; that run is then simply *waited for*, before this one's first
 * statement.
 *
 * **The lock connects to the DIRECT endpoint, never the pooler, and that is the whole design.**
 * `INTEGRATION_DATABASE_URL` resolves to Neon's `-pooler` host, which is PgBouncer in transaction
 * pooling mode. Probed against the live branch, two clients on the pooler BOTH acquired the same
 * key — mutual exclusion simply does not hold there:
 *
 *     connection | A acquired | pid stable | B also acquired
 *     pooler     | true       | true       | TRUE   <- broken
 *     direct     | true       | true       | false  <- correct
 *
 * Note `pid stable` is true through the pooler as well, so the obvious "did my backend change?"
 * self-check does not discriminate. A lock built on the configured URL would look like it worked
 * and would serialize nothing.
 *
 * **The lock lives in the maintenance database, not the reserved one.** Advisory locks are
 * database-local, and `--fresh` runs `pg_terminate_backend` over every session in the reserved
 * database and then drops it (`prepare.js`). A lock held there would be destroyed by the very run
 * it exists to block.
 *
 * **The key is two fixed literals, not a hash of the database name.** Every run of this harness
 * must contend, so one shared key is the requirement, not a limitation — and a hash would add
 * signed-`int4` conversion (`pg_advisory_lock(int4, int4)` rejects values above 2^31-1) for no
 * benefit while there is one reserved database.
 */
const { Client } = require("pg");
const path = require("path");
const { resolveIntegrationTarget, assertNoRedirectingParams, describeTarget } = require("./guard");

/**
 * `SAFE` and `MOLT` as ASCII, both inside int4. Shared by every run, deliberately.
 *
 * @type {{ classid: number, objid: number }}
 */
const HARNESS_LOCK_KEY = Object.freeze({ classid: 0x53414645, objid: 0x4d4f4c54 });

/**
 * Where a lock taken by Jest's `globalSetup` is parked so `globalTeardown` can release it.
 *
 * The two hooks run in one process but are loaded as separate module instances, so a module-level
 * variable does not survive between them; a `Symbol.for` key on `globalThis` does.
 */
const DIRECT_RUN_LOCK = Symbol.for("safemolt.integration.directRunLock");

/**
 * Targets this module resolved through the guard.
 *
 * `prepare()` used to call `resolveIntegrationTarget()` itself, which *was* the guard. Accepting a
 * caller's target — to close the race where a `.env.local` edit between two resolutions let a run
 * lock one target and provision another — removed that, so provisioning has to be able to tell a
 * guarded target from any other object.
 *
 * A `WeakSet` rather than a branding property: a symbol-keyed property is reachable through
 * `Object.getOwnPropertySymbols`, and it is inherited by anything prototyped on a genuine target,
 * so both give a caller a way to mint a "guarded" object naming a database the allowlist never
 * approved. Set membership has neither hole.
 */
const guardedTargets = new WeakSet();

/**
 * Whether *this process* holds the lock, and how deeply — kept on `process`, not in module state.
 *
 * It has to outlive a module registry, because Jest gives every test file its own: `globalSetup`
 * takes the lock through one instance of this file, and a suite asking `harnessLockIsHeld()`
 * through another would be told "no" while the process it runs in demonstrably holds the key —
 * which is how `prepare()` came to refuse inside a run that *was* locked.
 *
 * Jest does not hand test environments the identical `process` object; it deep-clones one per
 * environment, copying property descriptors. So this is carried by *copy*, not by sharing, and the
 * copy is taken after `globalSetup` runs — which is why the value is visible in a test file and why
 * `maxWorkers` must be 1. A worker is a separate OS process and gets no copy at all, so the config
 * pins it to one worker and `globalSetup` refuses any other setting.
 *
 * A property on `process` rather than an environment variable, and the distinction is the point: a
 * variable is inherited by spawned child processes, so it would outlive its owner and be believed
 * by a child whose parent's lock had already died with its session. This is not (confirmed: a
 * spawned child sees `undefined`).
 */
const DEPTH_KEY = "__safemoltIntegrationLockDepth";

function heldDepth() {
  return Number(process[DEPTH_KEY] ?? 0);
}

function setHeldDepth(depth) {
  Object.defineProperty(process, DEPTH_KEY, {
    value: depth,
    writable: true,
    configurable: true,
    enumerable: false,
  });
}

const DEFAULT_TIMEOUT_MS = 45 * 60 * 1000;
const PING_INTERVAL_MS = 30_000;

/** Query parameters that would change how the lock session behaves or how it is identified. */
const LOCK_HOSTILE_PARAMS = [
  "application_name",
  "options",
  "statement_timeout",
  "lock_timeout",
  "idle_session_timeout",
  "idle_in_transaction_session_timeout",
];

/** Resolve through the guard and record the result, so downstream code can trust it. */
function guardedTarget() {
  const target = Object.freeze(resolveIntegrationTarget());
  guardedTargets.add(target);
  return target;
}

function isGuardedTarget(target) {
  return Boolean(target && guardedTargets.has(target));
}

/** Resolve once, and reuse the caller's target when it is already guarded. */
function asGuardedTarget(target) {
  return isGuardedTarget(target) ? target : guardedTarget();
}

/** True while this process holds the harness lock. */
function harnessLockIsHeld() {
  return heldDepth() > 0;
}

/**
 * The direct (non-pooled) URL for the maintenance database.
 *
 * `endpointId` is the value the allowlist matched, so this narrows the connection to the
 * allowlisted host rather than widening anything — `normalisedHost` produced it by stripping a
 * `-pooler` suffix, which is Neon's convention for the two hostnames that address one branch. If a
 * future allowlist entry is not a Neon endpoint, that convention is what breaks, and it breaks by
 * failing to connect rather than by silently pooling.
 */
function lockConnectionUrl(target) {
  const url = new URL(target.maintenanceUrl);
  assertNoRedirectingParams(url, "the integration lock URL");
  url.hostname = target.endpointId;
  for (const param of LOCK_HOSTILE_PARAMS) url.searchParams.delete(param);
  return url.toString();
}

/** Who this is, for the message a waiting run prints. Postgres truncates at 63 bytes. */
function lockIdentity() {
  return `safemolt-integration pid=${process.pid} ${path.basename(process.cwd())}`.slice(0, 63);
}

function readTimeoutMs() {
  const raw = process.env.INTEGRATION_LOCK_TIMEOUT_MS;
  if (raw === undefined || raw === "") return DEFAULT_TIMEOUT_MS;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(
      `[integration] INTEGRATION_LOCK_TIMEOUT_MS='${raw}' is not a positive number of milliseconds.`
    );
  }
  return Math.floor(parsed);
}

/** A client that can never raise an unhandled `error` event, from construction to close. */
function lockClient(url, applicationName) {
  const client = new Client({ connectionString: url, application_name: applicationName, keepAlive: true });
  // Attached before `connect()`, and never removed: `pg` emits `error` independently of whichever
  // query is in flight, so a socket failure during connect, during the blocking wait, or during
  // shutdown would otherwise be an uncaught exception that takes the process down. It deliberately
  // does nothing — whoever cares is the awaited query that also rejects, or the `reportLost`
  // listener the holder adds on top of this one.
  client.on("error", () => {});
  return client;
}

/** The current holder's row, for the message a waiting run is shown. Never a basis for a decision. */
async function readHolder(client, key) {
  const { rows } = await client.query(
    `SELECT a.pid, a.application_name, a.backend_start
       FROM pg_locks l JOIN pg_stat_activity a ON a.pid = l.pid
      WHERE l.locktype = 'advisory' AND l.granted
        AND l.classid = $1::oid AND l.objid = $2::oid AND l.objsubid = 2
        AND l.pid <> pg_backend_pid()
      LIMIT 1`,
    [key.classid, key.objid]
  );
  const holder = rows[0];
  if (!holder) return "another run (its backend is no longer visible)";
  return `${holder.application_name || "an unnamed session"} (backend pid ${holder.pid}, started ${holder.backend_start})`;
}

/**
 * A canary for a pooled lock connection: a second client should not be able to take a key this one
 * already holds.
 *
 * It is a canary, not a proof. A pooled verifier may land on a *different* backend and be excluded
 * correctly, so passing does not establish that the endpoint is unpooled — but failing establishes
 * that it is, which is the direction that matters. Measured against the live branch, two clients on
 * the `-pooler` host do both acquire, and every single-connection check passes in that case.
 */
async function verifyExclusive(url, key) {
  const client = lockClient(url, `${lockIdentity()} verify`);
  try {
    await client.connect();
    // Inside a transaction so a pooler cannot move this session between statements: the acquire and
    // the drain below have to reach the same backend or the cleanup lands somewhere else.
    await client.query("BEGIN");
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1::int4, $2::int4) AS acquired", [
      key.classid,
      key.objid,
    ]);
    if (!rows[0].acquired) {
      await client.query("COMMIT").catch(() => {});
      return true;
    }

    // It acquired, so this connection shares a backend with the holder. Advisory locks are
    // re-entrant per session: the try *incremented* a count that already stood at one, so a single
    // unlock would leave the original acquisition stranded on a backend nobody owns — wedging the
    // shared key for every future run. Drain this exact key until it is gone, and only this key:
    // `pg_advisory_unlock_all()` would also release unrelated coordination held by other logical
    // clients that the pooler happens to have placed on this backend.
    for (let i = 0; i < 64; i++) {
      const { rows: unlocked } = await client.query(
        "SELECT pg_advisory_unlock($1::int4, $2::int4) AS released",
        [key.classid, key.objid]
      );
      if (!unlocked[0].released) break;
    }
    await client.query("COMMIT").catch(() => {});
    return false;
  } finally {
    await client.end().catch(() => {});
  }
}

/**
 * Acquire the harness lock, waiting for a run that already holds it.
 *
 * @param {object} options
 * @param {object} [options.target]    guarded target; re-resolved through the guard if absent
 * @param {{classid:number,objid:number}} [options.key]  overridden by tests so they do not queue
 *                                                       behind the run that is executing them
 * @param {number} [options.timeoutMs]
 * @param {(message: string) => void} [options.log]
 */
async function acquireHarnessLock(options = {}) {
  const key = options.key ?? HARNESS_LOCK_KEY;
  const target = asGuardedTarget(options.target);
  const log = options.log ?? ((message) => console.log(message));
  const timeoutMs = options.timeoutMs ?? readTimeoutMs();
  const url = lockConnectionUrl(target);

  const client = lockClient(url, lockIdentity());
  await client.connect();

  let released = false;
  let lost = null;

  try {
    const { rows } = await client.query("SELECT pg_try_advisory_lock($1::int4, $2::int4) AS acquired", [
      key.classid,
      key.objid,
    ]);

    if (!rows[0].acquired) {
      const holder = await readHolder(client, key);
      log(`[integration] waiting for the integration lock — held by ${holder}`);
      log(`[integration] it is released when that run finishes. Waiting up to ${Math.round(timeoutMs / 1000)}s.`);
      // Blocking, not polling: the server gives a real wait queue, so a later arrival cannot barge
      // ahead of a run that has been waiting, and there is no poll-interval latency on release.
      // `lock_timeout` covers advisory waits because they use the ordinary lock manager.
      await client.query(`SET lock_timeout = ${timeoutMs}`);
      try {
        await client.query("SELECT pg_advisory_lock($1::int4, $2::int4)", [key.classid, key.objid]);
      } catch (error) {
        if (error && error.code === "55P03") {
          throw new Error(
            `[integration] gave up waiting for the integration lock after ${Math.round(timeoutMs / 1000)}s.\n` +
              `It is held by ${holder}.\n` +
              `Wait for that run, or raise INTEGRATION_LOCK_TIMEOUT_MS.`
          );
        }
        throw error;
      } finally {
        await client.query("SET lock_timeout = 0").catch(() => {});
      }
    }

    if (!(await verifyExclusive(url, key))) {
      throw new Error(
        `[integration] the advisory lock does not exclude a second connection on ${describeTarget(url)}.\n` +
          `That means the lock session is pooled: PgBouncer in transaction mode hands the same key to\n` +
          `every client, so this lock would serialize nothing. Connect the lock to the DIRECT endpoint.`
      );
    }
  } catch (error) {
    await client.end().catch(() => {});
    throw error;
  }

  setHeldDepth(heldDepth() + 1);

  const api = {
    key,
    target,
    /**
     * Set once the lock session has died — the diagnosis behind a `stillHeld()` of false, not the
     * decision itself. The decision is always the server's answer.
     */
    get lost() {
      return lost;
    },
    /**
     * Ask the server whether this session still holds the key.
     *
     * The passive signals — the `error` event and the ping — need a free event loop, and two entry
     * points (`build.js`, the `prepare.js` CLI) block it with `spawnSync` for the whole of their
     * child's work. A run that spent ten minutes with its loop blocked would reach the end with
     * `lost` still null whether or not the lock survived. This asks outright, so the answer does
     * not depend on having been awake to notice. `pg` marks a disconnected client non-queryable and
     * never reconnects it, so a dead session fails here rather than answering for a new one.
     */
    async stillHeld() {
      if (released) return false;
      try {
        const { rows } = await client.query(
          `SELECT count(*)::int AS held FROM pg_locks
            WHERE locktype = 'advisory' AND granted AND pid = pg_backend_pid()
              AND classid = $1::oid AND objid = $2::oid AND objsubid = 2`,
          [key.classid, key.objid]
        );
        return rows[0].held > 0;
      } catch {
        // The session is gone, which is itself the answer.
        return false;
      }
    },
    async release() {
      if (released) return;
      released = true;
      setHeldDepth(Math.max(0, heldDepth() - 1));
      clearInterval(ping);
      // Session end releases it anyway; the explicit unlock just makes the intent legible and
      // frees a waiter fractionally sooner. The error listener stays attached through both calls.
      await client.query("SELECT pg_advisory_unlock($1::int4, $2::int4)", [key.classid, key.objid]).catch(() => {});
      await client.end().catch(() => {});
    },
  };

  // A session advisory lock is released when its session ends — including an ungraceful
  // disconnect — so a dropped connection silently lets a second run start while this one is still
  // issuing destructive SQL. Recording *why* is what makes `stillHeld()`'s "no" explicable: the
  // decision to fail is `stillHeld()`'s, taken from the server, but the diagnosis is this.
  const reportLost = (reason) => {
    if (released || lost) return;
    lost = reason instanceof Error ? reason : new Error(String(reason));
  };
  client.on("error", reportLost);

  const ping = setInterval(() => {
    client.query("SELECT 1").catch(reportLost);
  }, PING_INTERVAL_MS);
  if (ping.unref) ping.unref();

  return api;
}

/**
 * Resolve the target once, hold the lock for the whole of `fn`, and always release it.
 *
 * Refuses fast when this process already holds the lock. Waiting would be waiting on itself, and
 * the timeout would eventually report it as contention from another run.
 */
async function withHarnessLock(fn, options = {}) {
  if (harnessLockIsHeld()) {
    throw new Error(
      `[integration] this process already holds the integration lock.\n` +
        `Nesting a second entry point inside it would wait on its own lock until the timeout.\n` +
        `Run it on its own, or call the step directly instead of its wrapper.`
    );
  }

  const target = asGuardedTarget(options.target);
  const lock = await acquireHarnessLock({ ...options, target });
  try {
    const result = await fn(target, lock);
    // A run that cannot prove it still holds the lock cannot vouch for what it did: another run may
    // have been provisioning on top of it. Asked of the server rather than inferred from `lost`,
    // because an entry point that blocked its event loop never got the chance to notice.
    if (!(await lock.stillHeld())) {
      throw lock.lost ?? new Error(
        `[integration] the harness lock was not held at the end of this step.\n` +
          `Another run may have provisioned against the same database while this one worked.\n` +
          `Treat the results as void and run it again.`
      );
    }
    return result;
  } finally {
    await lock.release();
  }
}

module.exports = {
  DIRECT_RUN_LOCK,
  HARNESS_LOCK_KEY,
  acquireHarnessLock,
  guardedTarget,
  harnessLockIsHeld,
  isGuardedTarget,
  lockConnectionUrl,
  lockIdentity,
  readTimeoutMs,
  withHarnessLock,
};
