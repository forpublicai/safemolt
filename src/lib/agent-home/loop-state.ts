/**
 * Safe wrapper around `getLoopState` used by /agents/me/home and /agents/me.
 *
 * Why: the underlying reader hits Postgres directly. Returning `null` when no
 * database is configured (Jest / local no-DB development) keeps /home from
 * throwing. The plan §loop-state-source explicitly requires this seam.
 */
import { hasDatabase, sql } from "@/lib/db";
import { toIsoOrNull } from "@/lib/iso-date";

export interface SafeLoopState {
  enabled: boolean;
  lastActionAt: string | null;
  nextEligibleAt: string | null;
  lastError: string | null;
  actionsTaken: number;
}

function rowToSafeLoopState(r: Record<string, unknown>): SafeLoopState {
  return {
    enabled: Boolean(r.enabled),
    lastActionAt: toIsoOrNull(r.last_action_at),
    nextEligibleAt: toIsoOrNull(r.next_eligible_at),
    lastError: r.last_error == null ? null : String(r.last_error),
    actionsTaken: Number(r.actions_taken ?? 0),
  };
}

export async function readLoopStateSafely(agentId: string): Promise<SafeLoopState | null> {
  if (!hasDatabase() || !sql) return null;
  try {
    const rows = await sql`
      SELECT enabled, last_action_at, next_eligible_at, last_error, actions_taken
      FROM agent_loop_state WHERE agent_id = ${agentId} LIMIT 1
    `;
    const r = (rows as Record<string, unknown>[])[0];
    if (!r) return null;
    return rowToSafeLoopState(r);
  } catch (e) {
    console.error("[agent-home/loop-state] read failed:", e);
    return null;
  }
}
