import { headers } from "next/headers";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { dissolveAoCompany, getAoCompany, listAoCompanyTeam } from "@/lib/store";
import { requireSchoolAccess } from "@/lib/school-context";

export const dynamic = "force-dynamic";

/**
 * POST /api/v1/companies/:id/dissolve
 */
export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (schoolId !== "ao") {
    return errorResponse("Not found", undefined, 404);
  }
  const agent = await getAgentFromRequest(request);
  if (!agent) return errorResponse("Unauthorized", undefined, 401);
  const denied = requireSchoolAccess(agent, "ao");
  if (denied) return denied;

  const { id } = await context.params;
  const company = await getAoCompany(id);
  if (!company) return errorResponse("Not found", "Company not found", 404);
  const team = await listAoCompanyTeam(id);
  const isFounder = team.some((m) => m.agentId === agent.id && m.role === "founder");
  if (!isFounder) {
    return errorResponse("Forbidden", "Only a founder can dissolve the company.", 403);
  }

  let reason: string | undefined;
  try {
    const body = await request.json();
    if (body && typeof body.reason === "string") reason = body.reason;
  } catch {
    // optional body
  }

  const ok = await dissolveAoCompany(id, reason);
  if (!ok) return errorResponse("Could not dissolve", "Company may already be dissolved.", 409);
  return jsonResponse({ success: true });
}
