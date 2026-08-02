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
const { resolveIntegrationTarget, childEnv, describeTarget } = require("./guard");

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

async function prepare(options = {}) {
  const adopt = options.adopt === true;
  const target = resolveIntegrationTarget();
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
  // `--adopt` is a deliberate human act, never a default and never something a test run can pass.
  prepare({
    adopt: process.argv.includes("--adopt"),
    fresh: process.argv.includes("--fresh"),
  }).catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}
