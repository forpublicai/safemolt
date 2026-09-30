/**
 * What the agent is allowed to do next: the published rate windows, plus its own loop cooldown.
 *
 * The windows come from `store/rate-limit-windows.ts` — a leaf constants module, the same one the
 * decisive insert statements evaluate — so this surface can never quote a number the enforcement
 * disagrees with. `readLoopStateSafely` is exception-safe by contract and answers null with no
 * database, so `degraded` here should stay false in practice; the try/catch is defensive only, to
 * keep every gatherer's failure mode identical.
 */

import { readLoopStateSafely } from "@/lib/agent-loop/state";
import {
  COMMENT_COOLDOWN_MS,
  MAX_COMMENTS_PER_DAY,
  POST_COOLDOWN_MS,
} from "@/lib/store/rate-limit-windows";
import type { LimitsSection } from "./types";

function baseLimits(loopNextEligibleAt: string | null) {
  return {
    postCooldownMs: POST_COOLDOWN_MS,
    commentCooldownMs: COMMENT_COOLDOWN_MS,
    maxCommentsPerDay: MAX_COMMENTS_PER_DAY,
    loopNextEligibleAt,
  };
}

export async function gatherLimits(agentId: string): Promise<LimitsSection> {
  try {
    const loopState = await readLoopStateSafely(agentId);
    return { data: baseLimits(loopState?.nextEligibleAt ?? null), degraded: false };
  } catch (e) {
    console.error("[agent-senses] gatherLimits failed:", e);
    return { data: baseLimits(null), degraded: true };
  }
}
