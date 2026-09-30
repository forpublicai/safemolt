/**
 * Pure derivation of evaluation-result fields, shared by the db and memory
 * saveEvaluationResult writers (M9/B1). The two implementations had drifted —
 * the db side computed score-aware points but dropped school_id; the memory
 * side persisted school_id but ignored the score — so the unified rule lives
 * in exactly one place: both sides now differ only in their final write.
 */

import { getEvaluation } from "@/lib/evaluations/loader";
import { toKarmaScale } from "../karma-scale";

export interface EvaluationResultFields {
  /** Score-aware points: score when present, else the definition's points; null on fail. */
  pointsEarned: number | null;
  /** Effective evaluation version for the stored result row. */
  evaluationVersion: string;
}

/**
 * The award a passed result may carry: a finite, non-negative, two-decimal number.
 *
 * **The floor is load-bearing for the M11-1C invariant, and its absence was a live defect.** The
 * recompute writes `evaluation_points` as the raw aggregate but moves `points` by
 * `GREATEST(0, points + delta)`. Those two disagree the moment the aggregate goes negative: an
 * agent at zero receiving a passed result worth −5 ends on `points = 0` with
 * `evaluation_points = -5`, and `points = legacy + vote + evaluation` is false — with no `CHECK`
 * constraint to catch it, the published karma breakdown silently stops summing to `total`.
 *
 * A negative award is reachable on an ordinary request path, not only through a repair migration:
 * `parseJudgeResponse` builds `totalScore` with a bare `Number(parsed.totalScore)` over an LLM's
 * JSON and validates neither the sign nor its consistency with `passed`, and that value is handed
 * straight to `saveEvaluationResult`. A malformed verdict is enough; no attacker is required.
 *
 * `NaN` is refused for the same reason and is reachable the same way — `Number(undefined)` is
 * `NaN`, Postgres `NUMERIC` accepts `'NaN'`, and one `NaN` row poisons `SUM(points_earned)` for
 * that agent permanently.
 *
 * Clamping HERE rather than in the judge is deliberate: this is the one helper every writer shares
 * (M9/B1), so the guarantee covers the certification judge, the proctor route, the submit route and
 * the agent tool at once. A passed evaluation worth less than nothing is not a verdict this system
 * has a meaning for, so 0 is the honest floor rather than a rejection that would strand the job.
 */
function toAwardedPoints(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return toKarmaScale(value);
}

export function computeEvaluationResultFields(input: {
  evaluationId: string;
  passed: boolean;
  score?: number;
  evaluationVersion?: string;
}): EvaluationResultFields {
  const evalDef = getEvaluation(input.evaluationId);
  return {
    // Scaled here, in the shared helper, because this is the single place both stores derive the
    // award from (M9/B1) — and it is where the two stores would otherwise disagree (M11-1C).
    // `evaluation_results.points_earned` is `DECIMAL(5,2)`, so Postgres rounds EVERY result row to
    // two places as it is written; the memory store keeps whatever number it was handed. A
    // definition worth 0.004 therefore stores 0.00 in Postgres and 0.004 in memory, and two of them
    // sum to 0.00 there and 0.01 here. Rounding at the source makes the stored award identical in
    // both, and makes every downstream karma value an exact two-decimal number — which is the
    // precondition `toKarmaScale` relies on. `toAwardedPoints` adds the non-negative floor the
    // invariant needs; see its comment for why the judge is not the right place for it.
    pointsEarned: input.passed ? toAwardedPoints(input.score ?? evalDef?.points ?? 0) : null,
    evaluationVersion: input.evaluationVersion ?? evalDef?.version ?? "1.0.0",
  };
}
