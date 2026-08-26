/**
 * M11-2 P3.3 — the execution guard: an optional parameter beside Decision 2's prepared events,
 * populated ONLY by `src/lib/agent-pulse/runner.ts`. REST routes and external tool calls pass none.
 *
 * **Why this exists at all.** The runner's pre-terminal lease renewal (`renewLease`) is a fence, and
 * a fence alone is check-then-act: the renewal is a separate statement from the terminal mutation, so
 * a dashboard disable (`setLoopEnabled(agentId, false)`) can land in the gap between them. The
 * execution guard closes that gap by making the DECISIVE MUTATION ITSELF carry the check: the store
 * renders it as a CTE that locks the agent's `agent_loop_state` row `FOR SHARE` and validates
 * `enabled` plus the claiming wakeup's `claim_token` (still live, still uncompleted), with the
 * decisive mutation gated on it (`AND EXISTS (SELECT 1 FROM guard)`). The `FOR SHARE` lock is what
 * gives disable-vs-mutation a defined serialization order: a disable blocked behind an in-flight
 * mutation applies the instant it commits, and a disable that commits first makes the mutation return
 * zero rows — no write, no event — with the runner completing the wakeup as `error`. See
 * `ai/PLAN_M11_2.md` P3.3.
 *
 * **Placed in the store layer, not under `src/lib/agent-pulse/**`.** The u6 Lane D spec's fence
 * lists `agent-pulse/**` as the only NEW-file area, written with the runner itself in mind. A shared
 * SQL-fragment builder consumed by `src/lib/store/comments/db.ts` (and any future store module that
 * wires the guard in) belongs beside `src/lib/store/events/statement.ts` — the sibling Decision-2
 * renderer — rather than creating a store→runner dependency, which is the wrong direction: store
 * modules must not import from the package that calls them. Recorded here as a deliberate, minimal
 * deviation from the fence's literal file list, not an oversight.
 *
 * **No brand-validated value vocabulary here, unlike `events/statement.ts`.** That module's
 * constructors exist because it renders an open set of event kinds and column substitutions across
 * every domain, so a plain `string` option would be a public injection surface. This fragment has a
 * closed, fixed shape — three parameters, two fixed table names, no caller-supplied identifiers or
 * column references — so there is nothing dynamic to validate beyond the parameter count, and adding
 * that machinery here would be complexity with no attacker it stops.
 */

import { agentLoopState, wakeupQueue } from "./_memory-state";

/** Identifies the claim a runner-driven mutation must still hold when it executes. */
export interface ExecutionGuard {
  /** The acting agent — the `agent_loop_state` row the guard locks `FOR SHARE`. */
  agentId: string;
  /** The wakeup this mutation is being performed under. */
  wakeupId: number;
  /** The token stamped by `claimNextWakeup` — must still match, and the row must be uncompleted. */
  claimToken: string;
}

export interface ExecutionGuardFragment {
  /** `guard AS (...)` — splice into the caller's WITH list BEFORE any CTE that gates on it (a CTE
   *  may only reference one defined earlier in the same WITH list). Null when no guard was supplied,
   *  so the caller renders nothing and gates nothing. */
  cte: string | null;
  /** Append after the caller's own parameters (and after any event params) in this exact order. */
  params: unknown[];
}

/**
 * Render the execution guard as a WITH-list CTE, or nothing when the caller passed none.
 *
 * `firstParamIndex` is the 1-based placeholder the fragment's three params start at — the caller
 * must have already accounted for every parameter it and any rendered events consume.
 *
 * The `agent_wakeups` check is deliberately UNLOCKED (no `FOR SHARE`/`FOR UPDATE` on that row): only
 * `agent_loop_state` needs the lock, because that is the row the dashboard's disable route writes and
 * the one whose serialization order this guard exists to pin. Locking the wakeup row too would add
 * lock-order surface for no correctness gain — the token-fenced completion write is what makes
 * abandonment final for a superseded runner, not a lock held here.
 */
export function buildExecutionGuardCte(
  guard: ExecutionGuard | undefined,
  firstParamIndex: number
): ExecutionGuardFragment {
  if (!guard) return { cte: null, params: [] };
  if (!Number.isSafeInteger(firstParamIndex) || firstParamIndex < 1) {
    throw new Error(
      `[execution-guard] firstParamIndex must be a positive integer, received ${firstParamIndex}`
    );
  }
  const p1 = firstParamIndex;
  const p2 = firstParamIndex + 1;
  const p3 = firstParamIndex + 2;
  return {
    cte: `guard AS (
      SELECT 1 FROM agent_loop_state ls
      WHERE ls.agent_id = $${p1}::text AND ls.enabled
        AND EXISTS (
          SELECT 1 FROM agent_wakeups w
          WHERE w.id = $${p2}::bigint AND w.claim_token = $${p3}::text AND w.completed_at IS NULL
        )
      FOR SHARE
    )`,
    params: [guard.agentId, guard.wakeupId, guard.claimToken],
  };
}

/**
 * The memory-mode twin: does this guard pass, evaluated in the SAME synchronous section as the
 * mutation it gates (no `await` between this check and the write) — the same guarantee the db side's
 * row lock gives, for the reason every other memory-mode gate in this tree gives it (CLAUDE.md: "no
 * `await` between the check and the write").
 *
 * Mirrors the db fragment's two conditions exactly: the agent's loop state is enabled, AND the
 * claiming wakeup still carries this exact token and is not yet completed. `undefined` (no guard
 * supplied) always passes, matching the db side rendering no CTE and gating nothing.
 */
export function executionGuardPasses(guard: ExecutionGuard | undefined): boolean {
  if (!guard) return true;
  const state = agentLoopState.get(guard.agentId);
  if (!state || !state.enabled) return false;
  const wakeup = wakeupQueue.rows.get(guard.wakeupId);
  if (!wakeup || wakeup.claimToken !== guard.claimToken || wakeup.completedAt !== null) return false;
  return true;
}
