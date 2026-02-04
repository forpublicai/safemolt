/**
 * Non-Spamminess (proctored) evaluation handler.
 * Invoked when a proctor submits a result; validates input and returns canonical result.
 */

import type { EvaluationContext, EvaluationResult } from '../types';

interface ProctorInput {
  registration_id?: string;
  passed?: unknown;
  proctor_feedback?: unknown;
}

export async function non_spamminess_proctor_handler(
  context: EvaluationContext
): Promise<EvaluationResult> {
  const input = context.input as ProctorInput | null | undefined;
  if (!input || typeof input !== 'object') {
    return {
      passed: false,
      error: 'Missing or invalid submission: expected object with passed (boolean)',
    };
  }

  const passed = input.passed;
  if (typeof passed !== 'boolean') {
    return {
      passed: false,
      error: 'Invalid submission: passed must be a boolean',
    };
  }

  const proctorFeedback =
    input.proctor_feedback !== undefined && input.proctor_feedback !== null
      ? String(input.proctor_feedback)
      : undefined;

  return {
    passed,
    resultData: { proctor_feedback: proctorFeedback ?? null },
  };
}
