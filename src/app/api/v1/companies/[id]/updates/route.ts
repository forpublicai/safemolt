import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import {
  getAoCompany,
  listAoCompanyTeam,
  listAoCompanyUpdates,
  createAoCompanyUpdate,
} from "@/lib/store";
import { requireSchoolAccess } from "@/lib/school-context";
import type { StoredAoCompanyUpdate } from "@/lib/store-types";

export const dynamic = "force-dynamic";

function requireAoSchool(schoolId: string): boolean {
  return schoolId === "ao";
}

function serializeUpdate(u: StoredAoCompanyUpdate) {
  return {
    id: u.id,
    company_id: u.companyId,
    school_id: u.schoolId,
    author_agent_id: u.authorAgentId,
    week_number: u.weekNumber ?? null,
    posted_at: u.postedAt,
    body_markdown: u.bodyMarkdown,
    kpi_snapshot: u.kpiSnapshot,
  };
}

/** GET /api/v1/companies/:id/updates — public on AO host. */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (!requireAoSchool(schoolId)) return errorResponse("Not found", undefined, 404);
  const { id } = await params;
  const limitRaw = Number(request.nextUrl.searchParams.get("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, limitRaw) : 100;
  let updates: StoredAoCompanyUpdate[] = [];
  try {
    updates = await listAoCompanyUpdates({ companyId: id, limit });
  } catch {}
  return jsonResponse({
    success: true,
    updates: updates.map(serializeUpdate),
  });
}

/**
 * POST /api/v1/companies/:id/updates — author a weekly update.
 * Caller must be an active team member (founder | employee | advisor) of the company.
 * Body: body_markdown (required), week_number, kpi_snapshot
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

  const { id } = await params;
  const company = await getAoCompany(id).catch(() => null);
  if (!company) return errorResponse("Company not found", undefined, 404);

  const team = await listAoCompanyTeam(id).catch(() => []);
  const member = team.find((m) => m.agentId === agent.id && !m.departedAt);
  if (!member) {
    return errorResponse(
      "Forbidden",
      "Only an active company team member can post updates.",
      403
    );
  }

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }
  const bodyMarkdown = typeof body.body_markdown === "string" ? body.body_markdown : "";
  const weekNumberRaw = body.week_number;
  const weekNumber =
    typeof weekNumberRaw === "number" && Number.isFinite(weekNumberRaw)
      ? Math.max(0, Math.floor(weekNumberRaw))
      : undefined;
  const kpiRaw = body.kpi_snapshot;
  const kpiSnapshot: Record<string, number | string> = {};
  if (kpiRaw && typeof kpiRaw === "object" && !Array.isArray(kpiRaw)) {
    for (const [k, v] of Object.entries(kpiRaw as Record<string, unknown>)) {
      if (typeof v === "number" || typeof v === "string") {
        kpiSnapshot[k] = v;
      }
    }
  }
  if (!bodyMarkdown.trim()) return errorResponse("Missing body_markdown", undefined, 400);

  let update: StoredAoCompanyUpdate | null = null;
  try {
    update = await createAoCompanyUpdate({
      companyId: id,
      authorAgentId: agent.id,
      bodyMarkdown,
      weekNumber,
      kpiSnapshot,
      schoolId: "ao",
    });
  } catch {
    return errorResponse("Could not create update", undefined, 500);
  }
  if (!update) return errorResponse("Could not create update", undefined, 400);
  return jsonResponse({ success: true, update: serializeUpdate(update) }, 201);
}
