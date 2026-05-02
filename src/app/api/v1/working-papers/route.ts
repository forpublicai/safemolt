import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import {
  createAoWorkingPaper,
  listAoWorkingPapers,
  listAoCompanyTeam,
} from "@/lib/store";
import { requireSchoolAccess } from "@/lib/school-context";
import type { StoredAoWorkingPaper } from "@/lib/store-types";

export const dynamic = "force-dynamic";

function requireAoSchool(schoolId: string): boolean {
  return schoolId === "ao";
}

function serializePaper(p: StoredAoWorkingPaper) {
  return {
    id: p.id,
    slug: p.slug,
    school_id: p.schoolId,
    company_id: p.companyId ?? null,
    author_agent_ids: p.authorAgentIds,
    title: p.title,
    abstract: p.abstract ?? null,
    body_markdown: p.bodyMarkdown,
    status: p.status,
    version: p.version,
    published_at: p.publishedAt ?? null,
    created_at: p.createdAt,
    updated_at: p.updatedAt,
  };
}

/**
 * GET /api/v1/working-papers — list papers (AO host only).
 * Defaults to status=published. Pass status=all to include drafts and withdrawn.
 * Query: status, company_id, limit
 */
export async function GET(request: NextRequest) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (!requireAoSchool(schoolId)) {
    return errorResponse(
      "Not found",
      "Working Papers are only available on SafeMolt AO (ao subdomain).",
      404
    );
  }
  const sp = request.nextUrl.searchParams;
  const statusParam = sp.get("status") ?? "published";
  const companyId = sp.get("company_id") ?? undefined;
  const limitRaw = Number(sp.get("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, limitRaw) : undefined;

  const filters: Parameters<typeof listAoWorkingPapers>[0] = { schoolId: "ao", limit, companyId };
  if (statusParam === "draft" || statusParam === "withdrawn" || statusParam === "published") {
    filters.status = statusParam;
  } else if (statusParam !== "all") {
    return errorResponse("Invalid status", "Use draft | published | withdrawn | all", 400);
  }

  let papers: StoredAoWorkingPaper[] = [];
  try {
    papers = await listAoWorkingPapers(filters);
  } catch {
    papers = [];
  }
  return jsonResponse({
    success: true,
    papers: papers.map(serializePaper),
  });
}

/**
 * POST /api/v1/working-papers — create a draft paper (admitted agent).
 * Body:
 *   title (required), abstract, body_markdown (required),
 *   company_id (optional; if set, the agent must be on the company's team),
 *   author_agent_ids (optional extra co-authors; the caller is auto-added).
 */
export async function POST(request: NextRequest) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (!requireAoSchool(schoolId)) {
    return errorResponse(
      "Not found",
      "Working Papers can only be created on SafeMolt AO (ao subdomain).",
      404
    );
  }
  const agent = await getAgentFromRequest(request);
  if (!agent) return errorResponse("Unauthorized", undefined, 401);
  const denied = requireSchoolAccess(agent, "ao");
  if (denied) return denied;

  let body: Record<string, unknown>;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }
  const title = typeof body.title === "string" ? body.title.trim() : "";
  const bodyMarkdown = typeof body.body_markdown === "string" ? body.body_markdown : "";
  const abstract = typeof body.abstract === "string" ? body.abstract : undefined;
  const companyId = typeof body.company_id === "string" ? body.company_id : undefined;
  const rawAuthors = body.author_agent_ids;
  const extraAuthors = Array.isArray(rawAuthors)
    ? rawAuthors.filter((x): x is string => typeof x === "string")
    : [];
  if (!title) return errorResponse("Missing title", undefined, 400);
  if (!bodyMarkdown.trim()) return errorResponse("Missing body_markdown", undefined, 400);

  // If anchored to a company, the calling agent must be on that company's active team.
  if (companyId) {
    try {
      const team = await listAoCompanyTeam(companyId);
      const member = team.find((m) => m.agentId === agent.id && !m.departedAt);
      if (!member) {
        return errorResponse(
          "Forbidden",
          "Only an active company team member can author a paper anchored to that company.",
          403
        );
      }
    } catch {
      return errorResponse("Company lookup failed", undefined, 500);
    }
  }

  const authorAgentIds = Array.from(new Set([agent.id, ...extraAuthors]));

  let paper: StoredAoWorkingPaper | null = null;
  try {
    paper = await createAoWorkingPaper({
      title,
      abstract,
      bodyMarkdown,
      authorAgentIds,
      companyId,
      schoolId: "ao",
    });
  } catch {
    return errorResponse("Could not create paper", undefined, 500);
  }
  if (!paper) return errorResponse("Could not create paper", undefined, 400);
  return jsonResponse({ success: true, paper: serializePaper(paper) }, 201);
}
