/**
 * M11-2 u6 P3.1 — the always-on worker.
 *
 * `npm run worker` = `tsx worker/index.ts` (resolves `@/*` from `tsconfig.json`, same as the Next
 * app). A plain node loop + a tiny `node:http` server — no framework, no build step of its own. The
 * worker NEVER migrates: `scripts/migrate.js` runs during the Vercel deploy, and this process only
 * verifies the migrations it depends on are already recorded (see `checkMigrationLedger` below)
 * before doing any work.
 *
 * Loop duties (`ai/PLAN_M11_2.md` P3.1):
 *   (a) drain events → consumers                      — `runEventDrainPass` (shared with the cron route)
 *   (b) claim/run wakeups                              — `worker/wakeup-pass.ts`, wraps Lane D's `runPulseBatch`
 *   (c) playground deadlines, under the singleton lock  — `runDeadlinesAndCap`
 *   (d) housekeeping (abandoned leases, below-floor sweep, admissions offer-expiry, retention)
 *       — folded into (a): `runEventDrainPass`'s hourly duties cover all four
 *   (e) `node:http` `/healthz`, reporting the consumer-contract hash
 *   plus the P3.2-deferred idle scheduler (`worker/idle-scheduler.ts`), which `internal/agent-loop`
 *   also runs in degraded mode.
 *
 * Deploy order: the Vercel deploy that runs `scripts/migrate.js` for a given train's migrations must
 * precede the first worker deploy that depends on them. `render.yaml` (repo root) is this process's
 * Render service definition.
 */
import { createServer } from "node:http";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// --- .env.local, for local dev only (production sets real env vars on the host) ------------------
// `tsx` does not auto-load `.env.local` the way Next does; mirror `scripts/migrate.js`'s loader so
// `npm run worker` behaves the same locally as `npm run dev` / `npm run db:migrate`.
function loadEnvLocalIfNeeded(): void {
  if (process.env.POSTGRES_URL || process.env.DATABASE_URL) return;
  const envPath = join(__dirname, "..", ".env.local");
  if (!existsSync(envPath)) return;
  const content = readFileSync(envPath, "utf8");
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([^=]+)=(.*)$/);
    if (!match) continue;
    const key = match[1].trim();
    let value = match[2].trim();
    const quoted = (value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"));
    if (quoted) value = value.slice(1, -1);
    if (!process.env[key]) process.env[key] = value;
  }
}

loadEnvLocalIfNeeded();

/**
 * The migration-ledger boot check (P3.1). The list itself, and the pure "what's missing" logic, live
 * in `src/lib/worker/migration-ledger.ts` (import-testable; this file is a plain script, not a Jest
 * root). See that module's docs for why the check is a full ledger comparison, not a table probe.
 */
async function checkMigrationLedgerOrExit(): Promise<void> {
  const { checkMigrationLedger, REQUIRED_MIGRATIONS } = await import("@/lib/worker/migration-ledger");
  const result = await checkMigrationLedger();
  if (result.ok) {
    console.log(`[worker] Migration ledger OK (${REQUIRED_MIGRATIONS.length} required migrations recorded).`);
    return;
  }
  if (result.reason === "no_database") {
    console.error("[worker] FATAL: no POSTGRES_URL/DATABASE_URL configured. The worker requires a database.");
  } else {
    console.error(
      `[worker] FATAL: required migration(s) not recorded in _migrations: ${result.missing.join(", ")}. ` +
        "The Vercel deploy that runs `scripts/migrate.js` must complete before this worker starts."
    );
  }
  process.exit(1);
}

// --- env-tunable intervals --------------------------------------------------------------------

function envMs(name: string, def: number): number {
  const raw = Number(process.env[name] ?? def);
  return Number.isFinite(raw) && raw > 0 ? raw : def;
}

const DRAIN_INTERVAL_MS = envMs("WORKER_DRAIN_INTERVAL_MS", 10_000);
const DEADLINE_INTERVAL_MS = envMs("WORKER_DEADLINE_INTERVAL_MS", 60_000);
const WAKEUP_INTERVAL_MS = envMs("WORKER_WAKEUP_INTERVAL_MS", 5_000);
const IDLE_SWEEP_INTERVAL_MS = envMs("WORKER_IDLE_SWEEP_INTERVAL_MS", 60_000);
const SHUTDOWN_GRACE_MS = envMs("WORKER_SHUTDOWN_GRACE_MS", 240_000);
const PORT = Number(process.env.PORT ?? 3001);

// --- duty scheduling: one flag per duty so a slow pass never overlaps its own next tick ----------

let shuttingDown = false;
const inFlight = new Set<Promise<unknown>>();
let lastContractHash: string | null = null;
let lastDrainAt: number | null = null;
let lastDrainError: string | null = null;

/**
 * The shutdown half of the shared "stop claiming" signal (`src/lib/worker/stop-signal.ts`), handed to
 * every duty that claims work in a loop (E fix round 1, finding 5).
 *
 * Clearing the timers on `SIGTERM` stops the NEXT pass; it does nothing about the pass already
 * running, which kept claiming wakeup slots and playground sessions — starting fresh inference the
 * grace window then had to wait out, for work that a still-live instance would have taken anyway.
 * Duties read this before every new claim; whatever is already claimed finishes.
 *
 * The DRAIN duty deliberately does not take it. Its unit of work is an event whose completion is a
 * receipt, not a claim against a lease or an inference budget: a pass interrupted anywhere leaves the
 * unreceipted events for the next runtime's scan, and its own phase budget already bounds how long
 * one pass can run. There is nothing for a stop signal to prevent there.
 */
const isShuttingDown = (): boolean => shuttingDown;

function track<T>(promise: Promise<T>): Promise<T> {
  inFlight.add(promise);
  const settle = () => inFlight.delete(promise);
  promise.then(settle, settle);
  return promise;
}

/** Runs `fn` on `intervalMs`, skipping a tick if the previous invocation of THIS duty is still running. */
function scheduleDuty(name: string, intervalMs: number, fn: () => Promise<void>): NodeJS.Timeout {
  let busy = false;
  return setInterval(() => {
    if (shuttingDown || busy) return;
    busy = true;
    track(
      fn()
        .catch((error) => {
          console.error(`[worker] duty "${name}" failed`, error);
        })
        .finally(() => {
          busy = false;
        })
    );
  }, intervalMs);
}

async function runDrainDuty(): Promise<void> {
  const { runEventDrainPass } = await import("@/lib/worker/event-drain-pass");
  const { WORKER_HEARTBEAT_ID } = await import("@/lib/worker/schedule-honesty");
  try {
    const result = await runEventDrainPass(WORKER_HEARTBEAT_ID);
    lastContractHash = result.contractHash;
    lastDrainAt = Date.now();
    lastDrainError = null;
  } catch (error) {
    lastDrainError = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

async function runDeadlineDuty(): Promise<void> {
  const { runDeadlinesAndCap } = await import("@/lib/playground/lifecycle");
  // No runner override — the third argument is this process's shutdown flag, which the entry point
  // composes with its own lock-loss signal before handing ONE predicate to the sweep.
  await runDeadlinesAndCap("worker", undefined, isShuttingDown);
}

async function runWakeupDuty(): Promise<void> {
  const { claimAndRunWakeups } = await import("@/lib/worker/wakeup-pass");
  await claimAndRunWakeups(isShuttingDown);
}

async function runIdleSweepDuty(): Promise<void> {
  const { runIdleSweep } = await import("@/lib/worker/idle-scheduler");
  await runIdleSweep(isShuttingDown);
}

// --- node:http /healthz ---------------------------------------------------------------------------

const server = createServer((req, res) => {
  if (req.url === "/healthz") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        status: shuttingDown ? "shutting_down" : "ok",
        contract_hash: lastContractHash,
        last_drain_at: lastDrainAt ? new Date(lastDrainAt).toISOString() : null,
        last_drain_error: lastDrainError,
        in_flight: inFlight.size,
      })
    );
    return;
  }
  res.writeHead(404);
  res.end();
});

// --- boot + shutdown --------------------------------------------------------------------------

let timers: NodeJS.Timeout[] = [];

async function main(): Promise<void> {
  await checkMigrationLedgerOrExit();

  // The contract hash BEFORE the server accepts a request (E fix round 1, finding 6). It used to be
  // set only by the first successful drain, so `/healthz` answered `contract_hash: null` for the
  // first `WORKER_DRAIN_INTERVAL_MS` of every boot — and the deployment-version barrier reads exactly
  // that field to decide whether a runtime is on the target contract. A null was indistinguishable
  // from a wrong hash, so a cutover check racing a fresh worker saw a runtime it could not clear.
  // `computeConsumerContractHash` is pure and synchronous over this build's kind union and coverage
  // manifests — nothing about it needs a drain to have happened.
  const { computeConsumerContractHash } = await import("@/lib/events/consumer-contract");
  lastContractHash = computeConsumerContractHash();
  console.log(`[worker] consumer contract hash ${lastContractHash}`);

  server.listen(PORT, () => {
    console.log(`[worker] /healthz listening on :${PORT}`);
  });

  timers = [
    scheduleDuty("drain", DRAIN_INTERVAL_MS, runDrainDuty),
    scheduleDuty("deadlines", DEADLINE_INTERVAL_MS, runDeadlineDuty),
    scheduleDuty("wakeups", WAKEUP_INTERVAL_MS, runWakeupDuty),
    scheduleDuty("idle-sweep", IDLE_SWEEP_INTERVAL_MS, runIdleSweepDuty),
  ];

  console.log(
    `[worker] started — drain every ${DRAIN_INTERVAL_MS}ms, deadlines every ${DEADLINE_INTERVAL_MS}ms, ` +
      `wakeups every ${WAKEUP_INTERVAL_MS}ms, idle sweep every ${IDLE_SWEEP_INTERVAL_MS}ms.`
  );
}

/**
 * SIGTERM: stop claiming (clear every timer, so no NEW pass starts), then drain whatever is already
 * in flight up to `WORKER_SHUTDOWN_GRACE_MS` (default 240s; Render's own shutdown grace is configured
 * >= this). In-flight inference has no cancellation API, so crash-safety belongs to leases, not this
 * handler — a SIGKILLed tick's wakeup lease simply expires and housekeeping marks it `abandoned`
 * (never auto-re-run) on the next pass, by the worker or by the cron route.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[worker] ${signal} received — stopping new claims, draining in-flight work.`);
  for (const timer of timers) clearInterval(timer);

  const inFlightSnapshot = Array.from(inFlight);
  const grace = new Promise<"timeout">((resolve) => setTimeout(() => resolve("timeout"), SHUTDOWN_GRACE_MS));
  const drained = Promise.allSettled(inFlightSnapshot).then(() => "drained" as const);
  const outcome = await Promise.race([drained, grace]);
  if (outcome === "timeout") {
    console.error(
      `[worker] shutdown grace (${SHUTDOWN_GRACE_MS}ms) elapsed with ${inFlight.size} duty(ies) still in flight; exiting anyway.`
    );
  } else {
    console.log("[worker] all in-flight work settled; exiting.");
  }

  server.close();
  process.exit(0);
}

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});
process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

main().catch((error) => {
  console.error("[worker] fatal boot error", error);
  process.exit(1);
});
