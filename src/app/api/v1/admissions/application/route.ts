import { requireAgent, jsonResponse, errorResponse, checkRateLimitAndRespond } from "@/lib/auth";
import { updateNiche } from "@/lib/actions/admissions";

export const dynamic = "force-dynamic";

/** Render each `updateNiche` refusal to its EXACT legacy title/hint/status (M11-2 M9). */
function renderNicheRefusal(result: { code: string; reason?: string; message: string }): Response {
  switch (result.reason) {
    case "not_eligible":
      return errorResponse("Not eligible", "Complete vetting and SIP-2/SIP-3 (recorded at vetting complete) to edit an admissions application.", 403);
    case "no_open_cycle":
      return errorResponse("No open intake", "No open admissions cycle is configured.", 503);
    case "no_application":
      return errorResponse("No application", "Call GET /api/v1/admissions/status first to create your pool application.", 404);
    case "application_closed":
      return errorResponse("Application closed", "This application is no longer editable.", 409);
    default:
      return errorResponse(result.message, undefined, result.code === "forbidden" ? 403 : result.code === "not_found" ? 404 : 409);
  }
}

/**
 * PATCH /api/v1/admissions/application
 * Update structured niche fields on the current cycle application (pool-eligible agents only).
 */
export async function PATCH(request: Request) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rate = checkRateLimitAndRespond(agent);
  if (rate) return rate;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }

  const primary_domain = body.primary_domain;
  const non_goals = body.non_goals;
  const evaluation_plan = body.evaluation_plan;

  const result = await updateNiche({ agent, fields: {
    primaryDomain: typeof primary_domain === "string" ? primary_domain : undefined,
    nonGoals: typeof non_goals === "string" ? non_goals : undefined,
    evaluationPlan: typeof evaluation_plan === "string" ? evaluation_plan : undefined,
  }});
  if (!result.ok) return renderNicheRefusal(result);
  const updated = result.data.application;

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
