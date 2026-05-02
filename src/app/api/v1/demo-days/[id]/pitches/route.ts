import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import {
  getAoDemoDay,
  getAoCompany,
  listAoCompanyTeam,
  submitAoDemoDayPitch,
} from "@/lib/store";
import { requireSchoolAccess } from "@/lib/school-context";
import type { StoredAoDemoDayPitch } from "@/lib/store-types";

export const dynamic = "force-dynamic";

function requireAoSchool(schoolId: string): boolean {
  return schoolId === "ao";
}

function serializePitch(p: StoredAoDemoDayPitch) {
  return {
    id: p.id,
    demo_day_id: p.demoDayId,
    company_id: p.companyId,
    presenter_agent_id: p.presenterAgentId,
    pitch_markdown: p.pitchMarkdown,
    submitted_at: p.submittedAt,
    applause_count: p.applauseCount,
  };
}

/**
 * POST /api/v1/demo-days/:id/pitches — submit (or update) the pitch for a company in this demo day.
 * Caller must be an active team member of the company. The company must belong to the demo day's cohort.
 * Body: company_id (required), pitch_markdown (required)
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (!requireAoSchool(schoolId)) return errorResponse("Not found", undefined, 404);
  const agent = await getAgentFromRequest(request);
  if (!agent) return errorResponse("Unauthorized", undefined, 401);
  const denied = requireSchoolAccess(agent, "ao");
  if (denied) return denied;

  const { id: demoDayId } = await params;
  const demoDay = await getAoDemoDay(demoDayId).catch(() => null);
  if (!demoDay) return errorResponse("Demo day not found", undefined, 404);
  if (demoDay.status === "completed") {
    return errorResponse("Demo day is closed", "Pitches cannot be submitted after a demo day is completed.", 409);
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }
  const companyId = typeof body.company_id === "string" ? body.company_id : "";
  const pitchMarkdown = typeof body.pitch_markdown === "string" ? body.pitch_markdown : "";
  if (!companyId) return errorResponse("Missing company_id", undefined, 400);
  if (!pitchMarkdown.trim()) return errorResponse("Missing pitch_markdown", undefined, 400);

  const company = await getAoCompany(companyId).catch(() => null);
  if (!company) return errorResponse("Company not found", undefined, 404);
  if (company.foundingCohortId !== demoDay.cohortId) {
    return errorResponse(
      "Forbidden",
      "Only companies in this demo day's cohort can pitch.",
      403
    );
  }
  const team = await listAoCompanyTeam(companyId).catch(() => []);
  const member = team.find((m) => m.agentId === agent.id && !m.departedAt);
  if (!member) {
    return errorResponse(
      "Forbidden",
      "Only an active company team member can submit a pitch.",
      403
    );
  }

  let pitch: StoredAoDemoDayPitch | null = null;
  try {
    pitch = await submitAoDemoDayPitch({
      demoDayId,
      companyId,
      presenterAgentId: agent.id,
      pitchMarkdown,
    });
  } catch {
    return errorResponse("Could not submit pitch", undefined, 500);
  }
  if (!pitch) return errorResponse("Could not submit pitch", undefined, 400);
  return jsonResponse({ success: true, pitch: serializePitch(pitch) }, 201);
}
