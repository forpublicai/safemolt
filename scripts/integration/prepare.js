/**
 * M11-1 C0 — provision the integration database.
 *
 * Creates the reserved database if it does not exist, then applies `scripts/schema.sql` and every
 * registered migration through the *real* runner (`scripts/migrate.js`). Using the real runner is
 * the point: C1 hardens it, and C5/C14/C21/C22/C23 all assert migration behaviour, so a harness
 * that applied schema by some other route would test something the deploy never runs.
 */
const { Client } = require("pg");
const { spawnSync } = require("child_process");
const path = require("path");
const { childEnv, describeTarget } = require("./guard");
const { guardedTarget, harnessLockIsHeld, isGuardedTarget, withHarnessLock } = require("./lock");

/** Provenance stamp, asserted before anything destructive runs. */
const OWNER_MARKER_TABLE = "_harness_owner";
const OWNER_MARKER_VALUE = "safemolt-m11-integration-harness";

/** Does the reserved database exist? Asked from the maintenance database, writes nothing. */
async function reservedDatabaseExists(target) {
  const admin = new Client({ connectionString: target.maintenanceUrl });
  await admin.connect();
  try {
    const { rowCount } = await admin.query("SELECT 1 FROM pg_database WHERE datname = $1", [target.reservedDatabase]);
    return rowCount > 0;
  } finally {
    await admin.end();
  }
}

/**
 * Read the ownership marker out of an existing reserved database. Writes nothing.
 *
 * @returns {Promise<string|null>} the recorded owner, or null when the database carries no marker.
 */
async function readOwnerMarker(target) {
  const client = new Client({ connectionString: target.targetUrl });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT current_database() AS db");
    if (rows[0].db !== target.reservedDatabase) {
      throw new Error(
        `[integration] connected to '${rows[0].db}' but expected '${target.reservedDatabase}' — refusing to continue`
      );
    }
    const { rows: markerTable } = await client.query("SELECT to_regclass($1) IS NOT NULL AS present", [
      `public.${OWNER_MARKER_TABLE}`,
    ]);
    if (!markerTable[0].present) return null;
    const { rows: marker } = await client.query(`SELECT owner FROM ${OWNER_MARKER_TABLE} LIMIT 1`);
    return marker[0]?.owner ?? null;
  } finally {
    await client.end();
  }
}

/**
 * Decide what `--fresh` may do, given only what was *observed* before anything was written.
 *
 * Pure and exported so the decision itself can be tested exhaustively — it is the security
 * predicate, and the earlier code had no equivalent: it dropped the database first and consulted
 * the marker afterwards, so the documented `--fresh` command erased any database that merely
 * shared the reserved name on an allowlisted endpoint.
 *
 * @returns {"create" | "drop-and-create" | "reuse"}
 */
function decideProvisioning({ exists, owner, fresh }) {
  if (!exists) return "create";

  if (owner !== null && owner !== OWNER_MARKER_VALUE) {
    throw new Error(
      `[integration] '${OWNER_MARKER_TABLE}' records owner '${owner}', not this harness. Refusing to continue.`
    );
  }

  if (!fresh) return "reuse";

  if (owner !== OWNER_MARKER_VALUE) {
    throw new Error(
      `[integration] --fresh refuses to drop a database that carries no harness ownership marker.\n` +
        `A database sharing the reserved name may be somebody's data; provenance has to be proven before destruction,\n` +
        `not after. If you are certain this database is the harness's own, claim it deliberately first with:\n` +
        `  node scripts/integration/prepare.js --adopt\n` +
        `then re-run with --fresh.`
    );
  }
  return "drop-and-create";
}

async function ensureReservedDatabase(target, fresh) {
  if (!/^[a-z0-9_]+$/.test(target.reservedDatabase)) {
    throw new Error(`[integration] reservedDatabase '${target.reservedDatabase}' is not a safe identifier`);
  }

  // Proof before destruction. Both observations happen before a single byte is written, so a
  // wrong-marker or unmarked database is refused while it is still intact.
  const exists = await reservedDatabaseExists(target);
  const owner = exists ? await readOwnerMarker(target) : null;
  const action = decideProvisioning({ exists, owner, fresh });

  if (action === "reuse") return false;

  const admin = new Client({ connectionString: target.maintenanceUrl });
  await admin.connect();
  try {
    if (action === "drop-and-create") {
      // The runner skips any filename already in `_migrations` without reading the file, so editing
      // a migration after an earlier run leaves the tests executing stale schema. Rebuilding is the
      // only reliable way to pick an edit up.
      await admin.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = $1 AND pid <> pg_backend_pid()",
        [target.reservedDatabase]
      );
      await admin.query(`DROP DATABASE IF EXISTS ${target.reservedDatabase}`);
      console.log(`[integration] dropped database ${target.reservedDatabase} (--fresh, ownership marker verified)`);
    }

    // Identifier, not a value — cannot be parameterised. The name comes from the tracked
    // allowlist file, never from the environment, and was re-validated above.
    await admin.query(`CREATE DATABASE ${target.reservedDatabase}`);
    console.log(`[integration] created database ${target.reservedDatabase}`);
    return true;
  } finally {
    await admin.end();
  }
}

/**
 * @param {boolean} createdByUs   this run created the database, so it is ours by construction
 * @param {boolean} adopt         explicit human action: claim an existing unmarked database
 */
async function assertConnectedToReservedDatabase(target, createdByUs, adopt) {
  const client = new Client({ connectionString: target.targetUrl });
  await client.connect();
  try {
    const { rows } = await client.query("SELECT current_database() AS db");
    if (rows[0].db !== target.reservedDatabase) {
      throw new Error(
        `[integration] connected to '${rows[0].db}' but expected '${target.reservedDatabase}' — refusing to continue`
      );
    }

    // Proof before write. Reading the marker's existence *first* matters: creating the table and
    // then deciding whether adoption is allowed already modified a database that may not be ours.
    const { rows: markerTable } = await client.query(
      "SELECT to_regclass($1) IS NOT NULL AS present",
      [`public.${OWNER_MARKER_TABLE}`]
    );
    const marker = markerTable[0].present
      ? (await client.query(`SELECT owner FROM ${OWNER_MARKER_TABLE} LIMIT 1`)).rows
      : [];

    if (marker.length === 0) {
      // "Zero ordinary tables" is not evidence of emptiness — a database holding only views,
      // sequences or a non-public schema would have passed that test and been adopted silently.
      // Anything this run did not create requires the deliberate flag, full stop.
      if (!createdByUs && !adopt) {
        throw new Error(
          `[integration] '${target.reservedDatabase}' already exists and carries no harness ownership marker.\n` +
            `Refusing to adopt it. If you are certain this database is the harness's own (for example it predates the marker),\n` +
            `claim it deliberately with:  node scripts/integration/prepare.js --adopt`
        );
      }
      await client.query(`CREATE TABLE IF NOT EXISTS ${OWNER_MARKER_TABLE} (owner text PRIMARY KEY)`);
      await client.query(`INSERT INTO ${OWNER_MARKER_TABLE} (owner) VALUES ($1)`, [OWNER_MARKER_VALUE]);
    } else if (marker[0].owner !== OWNER_MARKER_VALUE) {
      throw new Error(
        `[integration] '${target.reservedDatabase}' is owned by '${marker[0].owner}', not this harness. Refusing to continue.`
      );
    }
  } finally {
    await client.end();
  }
}

function runRealMigrator(target) {
  const runner = path.join(__dirname, "..", "migrate.js");
  const result = spawnSync(process.execPath, [runner], {
    env: childEnv(target.targetUrl),
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(`[integration] migration runner exited ${result.status}`);
  }
}

/**
 * @param {object} [options]
 * @param {object} [options.target]  the target `withHarnessLock` resolved and locked. Only a target
 *                                   carrying that module's brand is trusted: passing the *same*
 *                                   object that was locked closes the lock-one-provision-another
 *                                   race, but accepting any caller-shaped object would have let a
 *                                   caller lock a harmless endpoint and provision an arbitrary one,
 *                                   which is exactly the guard `resolveIntegrationTarget` exists to
 *                                   be. Anything unbranded is re-resolved through the guard.
 */
async function prepare(options = {}) {
  const adopt = options.adopt === true;
  const target = isGuardedTarget(options.target) ? options.target : guardedTarget();

  // Everything below drops, creates, migrates or claims. None of it may run beside another run:
  // `--fresh` terminates every session on the reserved database and then drops it, which would kill
  // a concurrent suite mid-test. Entry points wrap themselves in `withHarnessLock`; this refuses
  // for any caller that forgot, rather than trusting the convention to hold.
  //
  // In-process state, not an inherited environment variable. Every caller of `prepare()` runs in
  // the same process as the `withHarnessLock` that wrapped it, so there is no boundary to carry a
  // claim across — and a claim that crossed one would outlive the lock it described.
  if (!harnessLockIsHeld()) {
    throw new Error(
      `[integration] refusing to provision without the harness lock.\n` +
        `Provisioning drops, creates and migrates the reserved database, so it must never run beside\n` +
        `another run. Use \`npm run test:integration\`, or wrap the call in \`withHarnessLock\` from\n` +
        `scripts/integration/lock.js.`
    );
  }

  console.log(`[integration] target: ${describeTarget(target.targetUrl)} (endpoint ${target.endpointId})`);
  const createdByUs = await ensureReservedDatabase(target, options.fresh === true);
  await assertConnectedToReservedDatabase(target, createdByUs, adopt);
  runRealMigrator(target);
  return target;
}

module.exports = {
  prepare,
  decideProvisioning,
  readOwnerMarker,
  reservedDatabaseExists,
  OWNER_MARKER_TABLE,
  OWNER_MARKER_VALUE,
};

if (require.main === module) {
  // Under the lock like every other entry point. `prepare.js --fresh` run by hand during a suite
  // was the worst of the bypasses: it terminates the running suite's connections and drops the
  // database, and the suite's own wrapper lock could not stop it.
  //
  // `--adopt` is a deliberate human act, never a default and never something a test run can pass.
  withHarnessLock((target) =>
    prepare({
      adopt: process.argv.includes("--adopt"),
      fresh: process.argv.includes("--fresh"),
      target,
    })
  ).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
