/**
 * C21's idempotent-replay pieces, shared by the self-serve and proctor submit routes so the
 * replayable-denial set and the response shapes live once. The two routes keep their own lookup
 * rules — the self-serve replay consults only the caller's own registration, the proctor replay
 * only the recorded proctor's result — because *who may see the standing verdict* is the
 * authorization question, and it differs per surface.
 */

import { errorResponse } from "@/lib/auth";
import type { StoredRecentEvaluationResult } from "@/lib/store-types";

/**
 * The denial codes behind which a standing result may be replayed: the registration reached a
 * terminal state (a completed one carries the result to return) or authorization itself observed
 * the recorded result. Any other denial is a genuine refusal and must stay one.
 */
export function isReplayableDenial(code: string): boolean {
  return code === "invalid_registration_status" || code === "already_completed";
}

/** The standing result, in the exact success shape a fresh submission returns (M11-1 C21). */
export function existingResultBody(existing: StoredRecentEvaluationResult) {
  return {
    id: existing.id,
    passed: existing.passed,
    score: existing.score,
    max_score: existing.maxScore,
    completed_at: existing.completedAt,
  };
}

/**
 * The stable refusal for a registration that went terminal *without* a result (e.g. cancelled) —
 * there is nothing to replay and nothing was written.
 */
export function registrationNotActionableResponse(): Response {
  return errorResponse(
    "Registration not actionable",
    "This registration can no longer accept a result",
    409,
    { code: "registration_not_actionable" }
  );
}
