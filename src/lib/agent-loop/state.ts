/**
 * The single agent_loop_state reader (M9/C8).
 *
 * The loop and the /agents/me(/home) surfaces previously read the same row
 * with different column sets and shapes (loop: last_seen_at + errors, no
 * last_action_at/last_error; home: the inverse), which is exactly the kind of
 * read-side drift M9 removes. One reader, one type; readLoopStateSafely is the
 * no-DB / error-tolerant wrapper for request-path consumers.
 */

import { hasDatabase, sql } from "@/lib/db";
import { toIsoOrNull } from "@/lib/iso-date";
import { agentLoopState } from "@/lib/store/_memory-state";

export interface LoopState {
  agentId: string;
  enabled: boolean;
  /** Newest post/comment timestamp the agent has already processed. */
  lastSeenAt: string | null;
  lastActionAt: string | null;
  /** Cooldown: earliest time the agent may act again. */
  nextEligibleAt: string | null;
  lastError: string | null;
  actionsTaken: number;
  errors: number;
}

/**
 * M11-2 P3.3: memory mode now has a real `agent_loop_state` twin
 * (`src/lib/store/_memory-state.ts`'s `agentLoopState` map), so this reader answers from it when no
 * database is configured instead of requiring `sql!` — the runner's claim statement and execution
 * guard both need a real `enabled` answer per agent in Jest / local no-DB runs. A missing row means
 * "not enabled", matching the db side, where the claim CTE's `EXISTS` fails the same way.
 */
export async function getLoopState(agentId: string): Promise<LoopState | null> {
  if (!hasDatabase() || !sql) {
    const state = agentLoopState.get(agentId);
    return state ? { ...state } : null;
  }
  const rows = await sql!`
    SELECT agent_id, enabled, last_seen_at, last_action_at, next_eligible_at, last_error, actions_taken, errors
    FROM agent_loop_state WHERE agent_id = ${agentId} LIMIT 1
  `;
  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    agentId: String(r.agent_id),
    enabled: Boolean(r.enabled),
    lastSeenAt: toIsoOrNull(r.last_seen_at),
    lastActionAt: toIsoOrNull(r.last_action_at),
    nextEligibleAt: toIsoOrNull(r.next_eligible_at),
    lastError: r.last_error == null ? null : String(r.last_error),
    actionsTaken: Number(r.actions_taken ?? 0),
    errors: Number(r.errors ?? 0),
  };
}

/**
 * Returns null instead of throwing when no database is configured (Jest /
 * local no-DB development) or the read fails, so /agents/me and /home never
 * 500 on loop-state.
 */
export async function readLoopStateSafely(agentId: string): Promise<LoopState | null> {
  if (!hasDatabase() || !sql) return null;
  try {
    return await getLoopState(agentId);
  } catch (e) {
    console.error("[agent-loop/state] read failed:", e);
    return null;
  }
}

/**
 * M11-2 P0.4: one journaled row per processed loop tick.
 *
 * Feeds the skip-tick inference share baseline (ai/validation/m11-baseline.md section 4) — release
 * gate 10 ("skip-tick inference share halved") has no obtainable pre-M11 denominator without it,
 * because today a skip only touches `agent_loop_state` and `agent_loop_action_log` records
 * successful terminal actions only. `outcome` is `acted | skipped | error`; `inferenceConsumed` is
 * whether the tick actually called the model; `terminalAction` is whether a terminal tool call
 * landed successfully. The share the soak measures is
 *   count(*) FILTER (WHERE inference_consumed AND NOT terminal_action) / count(*) FILTER (WHERE inference_consumed)
 *
 * DB-only, deliberately: in memory mode (Jest / local no-DB development) this is a no-op, because a
 * denominator computed from a process-local memory store during a test run cannot stand in for a
 * production baseline — the whole point of the soak is real traffic.
 *
 * Never throws (matches readLoopStateSafely's contract), and the whole body is ONE try/catch — not
 * just around the insert — so this is true for every path: `hasDatabase()` throwing (a test double
 * that omits it, say), `sql` being falsy, and the insert itself rejecting are all caught the same
 * way, and the function's own returned promise always resolves (never rejects). That is what makes
 * it safe for the tick path to call this with a bare `void`, never `await`: a floating promise that
 * can only ever resolve cannot produce an unhandled rejection, and a slow or wedged DB call must not
 * be able to delay the tick's return, its rethrow on error, or batch accounting — this write is
 * instrumentation, and the tick's own outcome can never depend on it landing in time.
 */
export interface AgentLoopTick {
  agentId: string;
  outcome: "acted" | "skipped" | "error";
  inferenceConsumed: boolean;
  terminalAction: boolean;
}

export async function recordAgentLoopTick(tick: AgentLoopTick): Promise<void> {
  try {
    if (!hasDatabase() || !sql) return;
    await sql`
      INSERT INTO agent_loop_tick_log (agent_id, outcome, inference_consumed, terminal_action)
      VALUES (${tick.agentId}, ${tick.outcome}, ${tick.inferenceConsumed}, ${tick.terminalAction})
    `;
  } catch (e) {
    console.error("[agent-loop/state] tick journal failed:", e);
  }
}
