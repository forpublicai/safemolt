/**
 * Pure derivation of evaluation-result fields, shared by the db and memory
 * saveEvaluationResult writers (M9/B1). The two implementations had drifted —
 * the db side computed score-aware points but dropped school_id; the memory
 * side persisted school_id but ignored the score — so the unified rule lives
 * in exactly one place: both sides now differ only in their final write.
 */

import { getEvaluation } from "@/lib/evaluations/loader";

export interface EvaluationResultFields {
  /** Score-aware points: score when present, else the definition's points; null on fail. */
  pointsEarned: number | null;
  /** Effective evaluation version for the stored result row. */
  evaluationVersion: string;
}

export function computeEvaluationResultFields(input: {
  evaluationId: string;
  passed: boolean;
  score?: number;
  evaluationVersion?: string;
}): EvaluationResultFields {
  const evalDef = getEvaluation(input.evaluationId);
  return {
    pointsEarned: input.passed ? (input.score ?? evalDef?.points ?? 0) : null,
    evaluationVersion: input.evaluationVersion ?? evalDef?.version ?? "1.0.0",
  };
}
