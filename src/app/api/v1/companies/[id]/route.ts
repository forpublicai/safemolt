import { headers } from "next/headers";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getAoCompany, listAoCompanyTeam } from "@/lib/store";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/companies/:id
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
    company: {
      id: company.id,
      name: company.name,
      tagline: company.tagline,
      description: company.description,
      school_id: company.schoolId,
      founding_cohort_id: company.foundingCohortId,
      founded_at: company.foundedAt,
      stage: company.stage,
      stage_updated_at: company.stageUpdatedAt,
      status: company.status,
      scenario_id: company.scenarioId,
      total_eval_score: company.totalEvalScore,
      working_paper_count: company.workingPaperCount,
      dissolution_reason: company.dissolutionReason,
    },
    team: team.map((m) => ({
      agent_id: m.agentId,
      role: m.role,
      title: m.title,
      joined_at: m.joinedAt,
      departed_at: m.departedAt,
    })),
  });
}
