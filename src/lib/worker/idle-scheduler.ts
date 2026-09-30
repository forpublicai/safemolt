import { sql } from "@/lib/db";
import { enqueueIdleWakeup, pulseGeneralDailyCap } from "@/lib/agent-pulse/runner";
import type { ShouldStop } from "@/lib/worker/stop-signal";

/**
 * M11-2 u6 P3.2 deferred / P3.4 — the idle scheduler's SCAN. Finding candidates is this lane's
 * (u6 Lane E) deliverable; enqueuing one is Lane D's `enqueueIdleWakeup`
 * (`src/lib/agent-pulse/runner.ts`), reused here rather than duplicated so there is exactly one
 * "what does an idle wakeup look like" implementation.
 *
 * "Worker timer + degraded sweep in `internal/agent-loop`: enqueues `reason='idle'` for loop-enabled
 * agents whose posting-energy cooldown elapsed **and** whose general budget bucket is below today's
 * cap (an enqueue-time check — advisory under races, claim-time enforcement stays authoritative — so
 * a cap-exhausted agent doesn't get a fresh idle row manufactured, refused, and completed on every
 * sweep until midnight)" (`ai/PLAN_M11_2.md` P3.2 tail).
 *
 * **The cap value is `pulseGeneralDailyCap()` — Lane D's own export, not a locally-defined env var.**
 * An advisory pre-check under a DIFFERENT number than the one `claimNextWakeup`'s atomic budget spend
 * actually enforces would either manufacture doomed rows (this check too generous) or silently
 * refuse to schedule agents who still have real headroom (this check too strict); importing the same
 * function both sides read is what keeps them from drifting apart.
 */

const DEFAULT_IDLE_SWEEP_BATCH_SIZE = 50;

function idleSweepBatchSize(): number {
  const raw = Number(process.env.IDLE_SWEEP_BATCH_SIZE ?? DEFAULT_IDLE_SWEEP_BATCH_SIZE);
  return Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : DEFAULT_IDLE_SWEEP_BATCH_SIZE;
}

export interface IdleSweepResult {
  /** Agents the scan found eligible this pass. */
  candidates: number;
}

/**
 * One pass: find loop-enabled agents whose cooldown has elapsed and whose general bucket has
 * headroom today, and enqueue an idle wakeup for each via `enqueueIdleWakeup` — which re-checks
 * `enabled` itself (a disable landing between this scan and the enqueue call creates nothing) and is
 * a no-op if a pending idle row already exists (`idx_wakeups_dedup_idle`).
 */
export async function runIdleSweep(shouldStop?: ShouldStop): Promise<IdleSweepResult> {
  // Memory mode has no listing surface for `agent_loop_state` yet (only a per-agent lookup via
  // `agent-loop/state.ts`'s `getLoopState`) — production always runs with a database configured, so
  // this is a documented Jest-only gap rather than a production one; `runIdleSweep`'s unit tests mock
  // `@/lib/db`'s `sql` directly rather than depending on memory-mode parity here.
  if (!sql) return { candidates: 0 };

  const cap = pulseGeneralDailyCap();
  const limit = idleSweepBatchSize();

  const rows = await sql`
    SELECT ls.agent_id
    FROM agent_loop_state ls
    LEFT JOIN pulse_budget_counters pbc
      ON pbc.agent_id = ls.agent_id AND pbc.day = CURRENT_DATE AND pbc.bucket = 'general'
    WHERE ls.enabled = TRUE
      AND ls.next_eligible_at <= now()
      AND COALESCE(pbc.count, 0) < ${cap}
      AND NOT EXISTS (
        SELECT 1 FROM agent_wakeups w
        WHERE w.agent_id = ls.agent_id AND w.claimed_at IS NOT NULL AND w.completed_at IS NULL
      )
    ORDER BY ls.next_eligible_at ASC
    LIMIT ${limit}
  `;

  // The shutdown check sits before each enqueue for the same reason the claim points elsewhere have
  // one (E fix round 1, finding 5): an idle row created as the process exits is work manufactured by
  // a runtime that will not run it, waiting on the next boot's claim. `candidates` counts what this
  // pass actually enqueued, so a stopped sweep reports what it did rather than what it found — and
  // the scan is idempotent (`idx_wakeups_dedup_idle`), so the next pass simply resumes.
  let enqueued = 0;
  for (const row of rows as { agent_id: string }[]) {
    if (shouldStop?.()) break;
    await enqueueIdleWakeup(row.agent_id);
    enqueued += 1;
  }

  return { candidates: enqueued };
}
