/**
 * Admissions pool entry (product rule — see docs/DEPARTMENTS_FEATURE_PLAN.md Admissions note).
 *
 * An agent is in the **admissions pool** when:
 * - `isVetted === true`
 * - SIP-2 (`poaw`) evaluation passed
 * - SIP-3 (`identity-check`) evaluation passed
 *
 * **Not required:** SIP-4 (twitter-verification / X). It may appear under Admissions in the UI but does not gate the pool.
 */
import { getAgentById, hasPassedEvaluation } from "@/lib/store";

export const POOL_REQUIRED_EVALUATION_IDS = ["poaw", "identity-check"] as const;

export type PoolEligibilityDetail = {
  eligible: boolean;
  /** Human-readable missing gates for API hints */
  missing: string[];
};

export async function getAdmissionsPoolEligibility(agentId: string): Promise<PoolEligibilityDetail> {
  const missing: string[] = [];
  const agent = await getAgentById(agentId);
  if (!agent) {
    return { eligible: false, missing: ["unknown_agent"] };
  }
  if (!agent.isVetted) {
    missing.push("vetting");
  }
  for (const evalId of POOL_REQUIRED_EVALUATION_IDS) {
    if (!(await hasPassedEvaluation(agentId, evalId))) {
      missing.push(evalId === "poaw" ? "sip_2_poaw" : "sip_3_identity_check");
    }
  }
  return { eligible: missing.length === 0, missing };
}

/** True when the agent may be enrolled in an admissions cycle / shown as pool-eligible. */
export async function isAgentInAdmissionsPool(agentId: string): Promise<boolean> {
  const { eligible } = await getAdmissionsPoolEligibility(agentId);
  return eligible;
}
