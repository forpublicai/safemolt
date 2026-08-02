/**
 * M11-1 C0 — `npm run test:integration` entry point.
 *
 * Guards the target, provisions the reserved database, then runs Jest with the node-environment
 * integration project. Jest receives a scrubbed environment whose POSTGRES_URL points at the
 * reserved database, so application code under test (`src/lib/db.ts` reads POSTGRES_URL at import)
 * talks to the harness database and nothing else.
 *
 * **This wrapper locks provisioning only, and Jest locks itself.** The lock has to be owned by
 * whichever process is doing the destructive work: hold one here across the whole run and a SIGKILL
 * of this process releases it while the orphaned Jest carries on issuing SQL, believing itself
 * covered by a wrapper that no longer exists. `jest-global-setup.js` therefore takes its own lock
 * before the first suite. Between this release and that acquire another run may win the lock — and
 * is then simply waited for, before this run's first statement.
 *
 * Jest is spawned asynchronously rather than with `spawnSync` so an interrupt can be forwarded to
 * it: `spawnSync` blocks the event loop, so a Ctrl-C would leave the suite running against a
 * database this process no longer coordinates.
 */
const { spawn } = require("child_process");
const path = require("path");
const { prepare } = require("./prepare");
const { childEnv } = require("./guard");
const { withHarnessLock } = require("./lock");

const REPO_ROOT = path.join(__dirname, "..", "..");

/** How long a stopped Jest gets to exit on its own before it is killed outright. */
const ESCALATE_AFTER_MS = 10_000;

/**
 * @returns {Promise<{code: number|null, signal: string|null}>} how Jest ended, unmapped. The caller
 *          decides the exit status: "killed by a signal" and "exited 1" are different outcomes, and
 *          reporting both as 1 hid interrupted runs among genuine test failures.
 */
function runJest(target, onSpawn) {
  const jestBin = path.join(REPO_ROOT, "node_modules", ".bin", "jest");
  // `--fresh` is ours, not Jest's; forwarding it makes Jest exit on an unrecognized option.
  const passThrough = process.argv.slice(2).filter((arg) => arg !== "--fresh");
  const args = ["--config", "jest.integration.config.js", "--runInBand", ...passThrough];

  return new Promise((resolve, reject) => {
    const child = spawn(jestBin, args, {
      env: childEnv(target.targetUrl, {
        INTEGRATION_RESERVED_DATABASE: target.reservedDatabase,
      }),
      stdio: "inherit",
      cwd: REPO_ROOT,
    });
    onSpawn(child);
    child.on("error", reject);
    child.on("close", (code, signal) => resolve({ code, signal }));
  });
}

async function main() {
  const fresh = process.argv.includes("--fresh");

  // Locked, and released before Jest starts. `--fresh` rebuilds the reserved database: the runner
  // skips recorded filenames without reading them, so an *edited* migration is otherwise never
  // re-applied.
  const target = await withHarnessLock(async (locked) => {
    await prepare({ fresh, target: locked });
    return locked;
  });

  let child = null;
  let abort = null;
  let escalation = null;

  /**
   * The run is no longer wanted. Stop Jest rather than leaving it writing to a database this
   * process has stopped watching.
   *
   * `exitCode === null` alone does not mean "still running" — a signal-terminated child reports
   * `exitCode === null` with `signalCode` set. Escalation matters for the same reason: `kill` only
   * *sends* a signal, and a Jest that ignores SIGTERM would otherwise keep going.
   */
  const stop = (reason, signal) => {
    abort = abort ?? reason;
    if (!child || child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal ?? "SIGTERM");
    if (escalation) return;
    escalation = setTimeout(() => {
      if (child && child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }, ESCALATE_AFTER_MS);
    if (escalation.unref) escalation.unref();
  };

  const onSignal = (signal) => stop(new Error(`[integration] interrupted by ${signal}`), signal);
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  let outcome;
  try {
    outcome = await runJest(target, (spawned) => {
      child = spawned;
      if (abort) stop(abort);
    });
  } finally {
    if (escalation) clearTimeout(escalation);
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
  }

  if (abort) throw abort;

  if (outcome.signal) {
    console.error(`[integration] jest was terminated by ${outcome.signal}`);
    process.exit(1);
  }
  process.exit(outcome.code === null ? 1 : outcome.code);
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
