/**
 * M11-1 C0 — integration-target guard.
 *
 * Every entry point into the integration harness resolves its connection through this module,
 * and this module refuses by default. The rules, and why each exists:
 *
 *   1. The URL comes from INTEGRATION_DATABASE_URL only. The real migration runner reads
 *      POSTGRES_URL/DATABASE_URL and loads .env.local when they are absent, so "just source the
 *      integration variable" cannot be achieved by convention — it has to be enforced by
 *      scrubbing the child environment. `childEnv()` below does that.
 *   2. The **full hostname** must appear in disposable-targets.json. A human writes that file; the
 *      harness never edits it. A marker row the harness writes itself could never prove
 *      *disposability* — it would prove only that it had write access, so any production URL could
 *      be marked and then truncated. That is why the disposability claim lives in a tracked file.
 *   3. All work happens in a reserved database, and the database named in the supplied URL is never
 *      migrated or truncated.
 *
 * Rule 3 is necessary but **not sufficient on its own**, and an earlier draft of this comment
 * overstated it. A pre-existing database that merely shares the reserved name would be adopted and
 * truncated. So `prepare` stamps an ownership marker in the database it creates, and the
 * destructive helper refuses without it. That marker proves *provenance* ("this database is the
 * harness's"), which a harness may legitimately assert about its own artefact — it is not, and is
 * never used as, a disposability proof.
 *
 * Absence of positive proof is a refusal, not a pass.
 */
const fs = require("fs");
const path = require("path");

const TARGETS_PATH = path.join(__dirname, "disposable-targets.json");

function loadTargets() {
  const raw = JSON.parse(fs.readFileSync(TARGETS_PATH, "utf8"));
  if (!raw.reservedDatabase || !Array.isArray(raw.disposableEndpoints)) {
    throw new Error(`[integration] ${TARGETS_PATH} is malformed: reservedDatabase and disposableEndpoints are required`);
  }
  return raw;
}

/**
 * Neon hostnames are `<endpoint-id>[-pooler].<region>.<provider>.neon.tech`. The pooled and direct
 * hosts address the same branch, so the `-pooler` suffix is normalised away — but **the rest of
 * the hostname is kept**. Matching on the first label alone would admit
 * `ep-<allowlisted-id>.attacker.example`, which is an allowlist that checks a prefix rather than
 * an identity.
 */
function normalisedHost(hostname) {
  const [first, ...rest] = String(hostname).split(".");
  return [first.replace(/-pooler$/, ""), ...rest].join(".");
}

/**
 * Read INTEGRATION_DATABASE_URL — and only that key — out of `.env.local`.
 *
 * This is a convenience so the variable can be set once, not a relaxation: POSTGRES_URL and
 * DATABASE_URL in the same file are deliberately never consulted, which is the whole reason the
 * runner's own dotenv path had to be scrubbed rather than reused.
 */
function integrationUrlFromEnvLocal() {
  const envPath = path.join(__dirname, "..", "..", ".env.local");
  if (!fs.existsSync(envPath)) return undefined;
  for (const rawLine of fs.readFileSync(envPath, "utf8").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^INTEGRATION_DATABASE_URL=(.*)$/);
    if (!match) continue;
    let value = match[1].trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    return value || undefined;
  }
  return undefined;
}

class IntegrationTargetRefusal extends Error {}

function refuse(reason, remedy) {
  throw new IntegrationTargetRefusal(
    `[integration] refusing to run: ${reason}\n${remedy}\n` +
      `Allowlist: ${TARGETS_PATH}`
  );
}

/**
 * `pg-connection-string` gives libpq-style query parameters precedence over the URL authority, so
 * `postgres://user:pass@allowlisted/db?host=elsewhere` passes any check that reads `url.hostname`
 * and then connects somewhere entirely different. Validating one host and connecting to another is
 * the whole failure this guard exists to prevent.
 *
 * Applied to every connection string the harness validates, not just the one the wrapper resolves:
 * the test process reads POSTGRES_URL and hands it straight to `pg`, so it inherits the same trap.
 */
const REDIRECTING_PARAMS = ["host", "hostaddr", "port", "dbname", "database", "service", "passfile", "servicefile"];

function assertNoRedirectingParams(url, variableName) {
  for (const param of REDIRECTING_PARAMS) {
    if (url.searchParams.has(param)) {
      refuse(
        `${variableName} carries a connection-redirecting parameter '${param}'`,
        "Remove it. The host and database are decided by the allowlist and the reserved name, never by query parameters."
      );
    }
  }
}

/**
 * Resolve and validate the integration target.
 *
 * @returns {{
 *   reservedDatabase: string,
 *   endpointId: string,
 *   targetUrl: string,      // the reserved database — the only thing the harness may modify
 *   maintenanceUrl: string, // the `postgres` maintenance database, used solely to CREATE DATABASE
 * }}
 */
function resolveIntegrationTarget() {
  const targets = loadTargets();
  const supplied = process.env.INTEGRATION_DATABASE_URL || integrationUrlFromEnvLocal();

  if (!supplied) {
    refuse(
      "INTEGRATION_DATABASE_URL is not set",
      "Set it (environment or .env.local) to a disposable Postgres branch. POSTGRES_URL/DATABASE_URL are deliberately ignored here."
    );
  }

  let url;
  try {
    url = new URL(supplied);
  } catch {
    return refuse("INTEGRATION_DATABASE_URL is not a valid URL", "Expected postgres://user:pass@host/db");
  }

  if (!/^postgres(ql)?:$/.test(url.protocol)) {
    refuse(`INTEGRATION_DATABASE_URL protocol '${url.protocol}' is not Postgres`, "Expected postgres:// or postgresql://");
  }

  const endpointId = normalisedHost(url.hostname);
  const allowed = targets.disposableEndpoints.some((entry) => entry.endpoint === endpointId);
  if (!allowed) {
    refuse(
      `host '${endpointId}' is not proven disposable`,
      "Add it to disposableEndpoints only if you are certain the branch is a throwaway. This is a deliberate human step."
    );
  }

  assertNoRedirectingParams(url, "INTEGRATION_DATABASE_URL");

  const buildUrl = (database) => {
    const built = new URL(url.toString());
    built.pathname = `/${database}`;
    return built.toString();
  };

  const targetUrl = buildUrl(targets.reservedDatabase);
  const maintenanceUrl = buildUrl("postgres");

  return {
    reservedDatabase: targets.reservedDatabase,
    endpointId,
    targetUrl,
    maintenanceUrl,
  };
}

/**
 * Build the environment for a child process (the real migration runner, or Jest).
 *
 * POSTGRES_URL and DATABASE_URL are removed before the integration URL is mapped in, so a child
 * can neither inherit the developer's database nor fall back to loading .env.local: the runner's
 * dotenv path only fires when both variables are absent, and here POSTGRES_URL is always set.
 */
function childEnv(targetUrl, extra = {}) {
  const env = { ...process.env };
  delete env.POSTGRES_URL;
  delete env.DATABASE_URL;
  delete env.PGDATABASE;
  delete env.PGHOST;
  delete env.PGUSER;
  delete env.PGPASSWORD;
  return { ...env, POSTGRES_URL: targetUrl, ...extra };
}

/** Masked target for logs — never print credentials. */
function describeTarget(urlString) {
  const url = new URL(urlString);
  return `${url.hostname}${url.pathname}`;
}

module.exports = {
  IntegrationTargetRefusal,
  assertNoRedirectingParams,
  childEnv,
  describeTarget,
  normalisedHost,
  loadTargets,
  resolveIntegrationTarget,
};
