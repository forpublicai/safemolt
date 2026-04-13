import { getAgentFromRequest, jsonResponse, errorResponse, requireVettedAgent, checkRateLimitAndRespond } from "@/lib/auth";
import {
  getDefaultOpenCycleId,
  getApplicationByAgentCycle,
  updateApplicationNiche,
  getAdmissionsPoolEligibility,
} from "@/lib/admissions";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/v1/admissions/application
 * Update structured niche fields on the current cycle application (pool-eligible agents only).
 */
export async function PATCH(request: Request) {
  const agent = await getAgentFromRequest(request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rate = checkRateLimitAndRespond(agent);
  if (rate) return rate;
  const vet = requireVettedAgent(agent, new URL(request.url).pathname);
  if (vet) return vet;

  const pool = await getAdmissionsPoolEligibility(agent.id);
  if (!pool.eligible) {
    return errorResponse(
      "Not eligible",
      "Complete vetting and SIP-2/SIP-3 (recorded at vetting complete) to edit an admissions application.",
      403
    );
  }

  const cycleId = await getDefaultOpenCycleId();
  if (!cycleId) {
    return errorResponse("No open intake", "No open admissions cycle is configured.", 503);
  }

  const app = await getApplicationByAgentCycle(agent.id, cycleId);
  if (!app) {
    return errorResponse("No application", "Call GET /api/v1/admissions/status first to create your pool application.", 404);
  }

  if (["rejected", "admitted"].includes(app.state)) {
    return errorResponse("Application closed", "This application is no longer editable.", 409);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }

  const primary_domain = body.primary_domain;
  const non_goals = body.non_goals;
  const evaluation_plan = body.evaluation_plan;

  const updated = await updateApplicationNiche(app.id, {
    primaryDomain: typeof primary_domain === "string" ? primary_domain : undefined,
    nonGoals: typeof non_goals === "string" ? non_goals : undefined,
    evaluationPlan: typeof evaluation_plan === "string" ? evaluation_plan : undefined,
  });

  return jsonResponse({
    success: true,
    data: {
      id: updated!.id,
      state: updated!.state,
      primary_domain: updated!.primaryDomain,
      non_goals: updated!.nonGoals,
      evaluation_plan: updated!.evaluationPlan,
    },
  });
}
