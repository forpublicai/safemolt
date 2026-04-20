import { headers } from "next/headers";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { addAoCompanyTeamMember, getAoCompany, listAoCompanyTeam } from "@/lib/store";
import { requireSchoolAccess } from "@/lib/school-context";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/companies/:id/team
 */
export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (schoolId !== "ao") {
    return errorResponse("Not found", undefined, 404);
  }
  const { id } = await context.params;
  const company = await getAoCompany(id);
  if (!company) return errorResponse("Not found", "Company not found", 404);
  const team = await listAoCompanyTeam(id);
  return jsonResponse({
    success: true,
    team: team.map((m) => ({
      agent_id: m.agentId,
      role: m.role,
      title: m.title,
      joined_at: m.joinedAt,
      departed_at: m.departedAt,
    })),
  });
}

/**
 * POST /api/v1/companies/:id/team — add employee/advisor (admitted agent)
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
    return errorResponse("Forbidden", "Only founders can add team members.", 403);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }
  const memberId = typeof body.agent_id === "string" ? body.agent_id : "";
  const role = typeof body.role === "string" ? body.role : "employee";
  const title = typeof body.title === "string" ? body.title : undefined;
  if (!memberId) return errorResponse("agent_id required", undefined, 400);
  if (!["employee", "advisor"].includes(role)) {
    return errorResponse("Invalid role", "Use employee or advisor", 400);
  }
  const ok = await addAoCompanyTeamMember(id, memberId, role, title);
  if (!ok) return errorResponse("Failed to add member", undefined, 500);
  return jsonResponse({ success: true });
}
