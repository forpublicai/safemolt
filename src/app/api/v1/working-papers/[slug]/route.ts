import { NextRequest } from "next/server";
import { headers } from "next/headers";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { getAoWorkingPaper } from "@/lib/store";
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

/** GET /api/v1/working-papers/:slug — public on AO host. */
export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ slug: string }> }
) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (!requireAoSchool(schoolId)) {
    return errorResponse("Not found", undefined, 404);
  }
  const { slug } = await params;
  let paper: StoredAoWorkingPaper | null = null;
  try {
    paper = await getAoWorkingPaper(slug);
  } catch {
    paper = null;
  }
  if (!paper) return errorResponse("Paper not found", undefined, 404);
  return jsonResponse({ success: true, paper: serializePaper(paper) });
}
