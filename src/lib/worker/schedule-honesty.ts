import { sql } from "@/lib/db";

/**
 * M11-2 u6 P3.4 (M10 C8) — scheduling honesty: what `GET /api/v1/internal/agent-loop` tells a caller
 * about how long an eligible agent should expect to wait for its next tick, and whether an always-on
 * worker or the degraded cron-only topology is actually driving it right now.
 *
 * `WORKER_HEARTBEAT_ID` is a worker's own `worker_heartbeats` row, stamped by `worker/index.ts`'s
 * drain-pass duty (`runEventDrainPass(WORKER_HEARTBEAT_ID)`) every fast-loop pass. A recent row means
 * a worker is alive; its absence — or staleness past `WORKER_LIVENESS_WINDOW_MS` — means this
 * deployment is running degraded (Vercel cron only), which is the honest fallback: an unreachable
 * worker must never be reported as though it were driving ticks.
 */
export const WORKER_HEARTBEAT_ID = "worker";

const DEFAULT_WORKER_LIVENESS_WINDOW_MS = 2 * 60 * 1000;

function workerLivenessWindowMs(): number {
  const raw = Number(process.env.WORKER_LIVENESS_WINDOW_MS ?? DEFAULT_WORKER_LIVENESS_WINDOW_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_WORKER_LIVENESS_WINDOW_MS;
}

/** Mirrors `agent-loop.ts`'s own `AGENT_LOOP_BATCH_SIZE` parse — same env var, same default, kept in
 * sync by convention rather than by import: `agent-loop.ts` is a different lane's fence. */
const DEFAULT_AGENT_LOOP_BATCH_SIZE = 2;

function agentLoopBatchSize(): number {
  const raw = parseInt(process.env.AGENT_LOOP_BATCH_SIZE || String(DEFAULT_AGENT_LOOP_BATCH_SIZE), 10);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_AGENT_LOOP_BATCH_SIZE;
}

/** `internal/agent-loop`'s `vercel.json` cadence — the degraded-mode formula's other input. */
const CRON_CADENCE_SECONDS = 30 * 60;

export type ScheduleMode = "worker" | "degraded";

export interface ScheduleHonesty {
  mode: ScheduleMode;
  expected_wait_seconds: number;
  schedule_note: string;
}

async function isWorkerAlive(): Promise<boolean> {
  if (!sql) return false;
  const rows = await sql`
    SELECT seen_at FROM worker_heartbeats WHERE worker_id = ${WORKER_HEARTBEAT_ID}
    ORDER BY seen_at DESC LIMIT 1
  `;
  const row = rows[0] as { seen_at?: string } | undefined;
  if (!row?.seen_at) return false;
  return Date.now() - Date.parse(row.seen_at) <= workerLivenessWindowMs();
}

async function countRow(query: Promise<unknown[]>): Promise<number> {
  const rows = await query;
  return Number((rows[0] as { n?: number | string } | undefined)?.n ?? 0);
}

/** Recent wakeup completion rate, per second, over a trailing window — worker mode's denominator. */
async function recentWakeupCompletionRate(): Promise<number> {
  if (!sql) return 0;
  const windowSeconds = 300;
  const n = await countRow(
    sql`
      SELECT count(*)::int AS n FROM agent_wakeups
      WHERE completed_at IS NOT NULL AND completed_at >= now() - make_interval(secs => ${windowSeconds})
    `
  );
  return n / windowSeconds;
}

async function pendingWakeupQueueDepth(): Promise<number> {
  if (!sql) return 0;
  return countRow(
    sql`
      SELECT count(*)::int AS n FROM agent_wakeups
      WHERE completed_at IS NULL AND claimed_at IS NULL AND delivery = 'internal' AND due_at <= now()
    `
  );
}

async function eligibleAgentCount(): Promise<number> {
  if (!sql) return 0;
  return countRow(
    sql`SELECT count(*)::int AS n FROM agent_loop_state WHERE enabled = TRUE AND next_eligible_at <= now()`
  );
}

/**
 * `meta.mode` + both `expected_wait_seconds` formulas (M10 C8, `ai/PLAN_M11_2.md` P3.4): worker mode
 * divides the pending internal-delivery queue depth by a trailing completion rate; degraded mode
 * multiplies the eligible-agent count by the cron cadence and divides by the batch size. Either
 * formula can only ever be an estimate — both read live, moving state — so this is advisory
 * scheduling information for a caller, never a promise.
 */
export async function computeScheduleHonesty(): Promise<ScheduleHonesty> {
  if (await isWorkerAlive()) {
    const [depth, rate] = await Promise.all([pendingWakeupQueueDepth(), recentWakeupCompletionRate()]);
    const expectedWaitSeconds = rate > 0 ? depth / rate : depth > 0 ? CRON_CADENCE_SECONDS : 0;
    return {
      mode: "worker",
      expected_wait_seconds: Math.round(expectedWaitSeconds),
      schedule_note: `Always-on worker draining continuously; ${depth} wakeup(s) pending.`,
    };
  }

  const batchSize = agentLoopBatchSize();
  const eligible = await eligibleAgentCount();
  const expectedWaitSeconds = batchSize > 0 ? (eligible * CRON_CADENCE_SECONDS) / batchSize : 0;
  return {
    mode: "degraded",
    expected_wait_seconds: Math.round(expectedWaitSeconds),
    schedule_note: `Degraded (cron-only) mode; ticks run every ${Math.round(
      CRON_CADENCE_SECONDS / 60
    )} minutes, batch of ${batchSize}.`,
  };
}
