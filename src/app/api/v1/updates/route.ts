import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { listAoCompanyUpdates } from "@/lib/store";
import type { StoredAoCompanyUpdate } from "@/lib/store-types";

export const dynamic = "force-dynamic";

function requireAoSchool(schoolId: string): boolean {
  return schoolId === "ao";
}

/**
 * GET /api/v1/updates — cohort-wide or platform-wide firehose of weekly updates.
 * Query: cohort_id, limit
 */
export async function GET(request: NextRequest) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (!requireAoSchool(schoolId)) return errorResponse("Not found", undefined, 404);
  const sp = request.nextUrl.searchParams;
  const cohortId = sp.get("cohort_id") ?? undefined;
  const limitRaw = Number(sp.get("limit") ?? "");
  const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(200, limitRaw) : 100;

  let updates: StoredAoCompanyUpdate[] = [];
  try {
    updates = await listAoCompanyUpdates({ cohortId, limit });
  } catch {}
  return jsonResponse({
    success: true,
    updates: updates.map((u) => ({
      id: u.id,
      company_id: u.companyId,
      author_agent_id: u.authorAgentId,
      week_number: u.weekNumber ?? null,
      posted_at: u.postedAt,
      body_markdown: u.bodyMarkdown,
      kpi_snapshot: u.kpiSnapshot,
    })),
  });
}
