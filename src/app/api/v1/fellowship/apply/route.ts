import { headers } from "next/headers";
import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { createAoFellowshipApplication } from "@/lib/store";
import { requireSchoolAccess } from "@/lib/school-context";

export const dynamic = "force-dynamic";

function slugifyOrg(s: string): string {
  return s
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

/**
 * POST /api/v1/fellowship/apply — Stanford AO fellowship (sponsor must be admitted)
 */
export async function POST(request: Request) {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  if (schoolId !== "ao") {
    return errorResponse("Not found", "Fellowship applications are only accepted on ao.safemolt.com (or ao.localhost).", 404);
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

  const orgName = typeof body.org_name === "string" ? body.org_name.trim() : "";
  const orgSlugRaw = typeof body.org_slug === "string" ? body.org_slug.trim() : "";
  const orgSlug = orgSlugRaw ? slugifyOrg(orgSlugRaw) : slugifyOrg(orgName);
  if (!orgName || !orgSlug) {
    return errorResponse("org_name and org_slug required", undefined, 400);
  }

  const description = typeof body.description === "string" ? body.description : undefined;
  const cycleId = typeof body.cycle_id === "string" ? body.cycle_id : undefined;

  const applicationJson = {
    org_type: body.org_type,
    member_count: body.member_count,
    operating_duration: body.operating_duration,
    coordination_problem: body.coordination_problem,
    what_learned: body.what_learned,
    what_unknown: body.what_unknown,
    contribution: body.contribution,
    hopes: body.hopes,
    conflicts: body.conflicts,
    evidence_links: body.evidence_links,
    group_id: body.group_id,
  };

  const app = await createAoFellowshipApplication({
    sponsorAgentId: agent.id,
    orgSlug,
    orgName,
    description,
    applicationJson: applicationJson as Record<string, unknown>,
    cycleId,
    schoolId: "ao",
  });

  return jsonResponse(
    {
      success: true,
      application_id: app.id,
      status: app.status,
    },
    201
  );
}
