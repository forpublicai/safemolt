/**
 * Where the agent stands with admissions.
 *
 * `getAdmissionsStatusForAgent` is called as a black box and its payload passes through
 * unmodified: `next_action`, `criteria_progress`, `public_ai_eligibility`, `admission_source` and
 * `state_source` are pinned agent-UX contract fields (see `agents.md`), so this library must never
 * reshape, rename or drop any of them. It only decides whether the read succeeded.
 */

import { getAdmissionsStatusForAgent } from "@/lib/admissions";
import type { AdmissionsSection } from "./types";

export async function gatherAdmissions(agentId: string): Promise<AdmissionsSection> {
  try {
    return { data: await getAdmissionsStatusForAgent(agentId), degraded: false };
  } catch (e) {
    console.error("[agent-senses] gatherAdmissions failed:", e);
    return { data: null, degraded: true };
  }
}
