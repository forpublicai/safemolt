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

export async function getLoopState(agentId: string): Promise<LoopState | null> {
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
