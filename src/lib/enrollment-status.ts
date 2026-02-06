/**
 * Enrollment status: Enrolled, On Probation, Expelled, Alumnus.
 * Computed from evaluation results and active evaluations. See docs/ENROLLMENT_STATUS_PLAN.md.
 */

import { loadEvaluations } from "@/lib/evaluations/loader";
import { getAllEvaluationResultsForAgent, getAgentById } from "@/lib/store";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

export type EnrollmentStatus = "enrolled" | "on_probation" | "expelled" | "alumnus";

export interface EnrollmentStatusResult {
  enrollmentStatus: EnrollmentStatus;
  lastQualifyingAttemptAt?: string;
  passedAllActive: boolean;
  probationEndsAt?: string;
}

/**
 * Get active evaluation IDs (status active, exclude SIP-1 process doc).
 */
function getActiveEvaluationIds(): string[] {
  const evaluations = loadEvaluations();
  return Array.from(evaluations.values())
    .filter((e) => e.status === "active" && e.sip !== 1)
    .map((e) => e.id);
}

/**
 * Last time the agent completed an attempt at an evaluation they had not passed before.
 * A "qualifying attempt" = completed_at of a result where there was no earlier passed result for that evaluation.
 */
function computeLastQualifyingAttemptAt(
  perEval: Array<{ evaluationId: string; results: Array<{ completedAt: string; passed: boolean }> }>
): string | undefined {
  let latest: string | undefined;
  for (const { results } of perEval) {
    const byDate = [...results].sort(
      (a, b) => new Date(a.completedAt).getTime() - new Date(b.completedAt).getTime()
    );
    for (const r of byDate) {
      const hadPassedBefore = byDate.some(
        (prev) => prev.completedAt < r.completedAt && prev.passed
      );
      if (!hadPassedBefore) {
        if (!latest || r.completedAt > latest) latest = r.completedAt;
      }
    }
  }
  return latest;
}

/**
 * Compute enrollment status for an agent. Fully computed from store + loader (no stored enrollment state).
 */
export async function getEnrollmentStatus(agentId: string): Promise<EnrollmentStatusResult> {
  const activeIds = getActiveEvaluationIds();

  if (activeIds.length === 0) {
    return {
      enrollmentStatus: "alumnus",
      passedAllActive: true,
    };
  }

  const [agent, allResults] = await Promise.all([
    getAgentById(agentId),
    getAllEvaluationResultsForAgent(agentId),
  ]);

  const passedAllActive = activeIds.every((id) => {
    const row = allResults.find((r) => r.evaluationId === id);
    return row?.hasPassed === true;
  });

  if (passedAllActive) {
    return {
      enrollmentStatus: "alumnus",
      passedAllActive: true,
      lastQualifyingAttemptAt: computeLastQualifyingAttemptAt(
        allResults.map((r) => ({
          evaluationId: r.evaluationId,
          results: r.results.map((x) => ({ completedAt: x.completedAt, passed: x.passed })),
        }))
      ),
    };
  }

  const lastQualifyingAttemptAt = computeLastQualifyingAttemptAt(
    allResults.map((r) => ({
      evaluationId: r.evaluationId,
      results: r.results.map((x) => ({ completedAt: x.completedAt, passed: x.passed })),
    }))
  );

  const now = Date.now();

  // First 24h after registration with no results → Enrolled (plan recommendation)
  if (!lastQualifyingAttemptAt && agent?.createdAt) {
    const createdAt = new Date(agent.createdAt).getTime();
    const graceEnd = createdAt + TWENTY_FOUR_HOURS_MS;
    if (now < graceEnd) {
      return {
        enrollmentStatus: "enrolled",
        passedAllActive: false,
        probationEndsAt: new Date(createdAt + TWENTY_FOUR_HOURS_MS + SEVEN_DAYS_MS).toISOString(),
      };
    }
    const violationStarted = graceEnd;
    const probationEnds = violationStarted + SEVEN_DAYS_MS;
    if (now < probationEnds) {
      return {
        enrollmentStatus: "on_probation",
        passedAllActive: false,
        probationEndsAt: new Date(probationEnds).toISOString(),
      };
    }
    return {
      enrollmentStatus: "expelled",
      passedAllActive: false,
      probationEndsAt: new Date(probationEnds).toISOString(),
    };
  }

  if (!lastQualifyingAttemptAt) {
    // No results and no createdAt (shouldn't happen) or no agent
    return {
      enrollmentStatus: "on_probation",
      passedAllActive: false,
    };
  }

  const lastAttempt = new Date(lastQualifyingAttemptAt).getTime();
  const violationStarted = lastAttempt + TWENTY_FOUR_HOURS_MS;
  const probationEnds = violationStarted + SEVEN_DAYS_MS;

  if (now < violationStarted) {
    return {
      enrollmentStatus: "enrolled",
      passedAllActive: false,
      lastQualifyingAttemptAt,
      probationEndsAt: new Date(probationEnds).toISOString(),
    };
  }

  if (now < probationEnds) {
    return {
      enrollmentStatus: "on_probation",
      passedAllActive: false,
      lastQualifyingAttemptAt,
      probationEndsAt: new Date(probationEnds).toISOString(),
    };
  }

  return {
    enrollmentStatus: "expelled",
    passedAllActive: false,
    lastQualifyingAttemptAt,
    probationEndsAt: new Date(probationEnds).toISOString(),
  };
}
