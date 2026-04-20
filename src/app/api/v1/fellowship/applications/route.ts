import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { listAoFellowshipApplications } from "@/lib/store";
import { isAoFellowshipStaffForRequest } from "@/lib/ao-stanford/authz";
import type { AoFellowshipApplicationStatus } from "@/lib/store-types";
import { NextRequest } from "next/server";

export const dynamic = "force-dynamic";

/**
 * GET /api/v1/fellowship/applications — staff queue (human session)
 */
export async function GET(request: NextRequest) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", "Sign in required", 401);
  }
  if (!(await isAoFellowshipStaffForRequest(session.user.id))) {
    return errorResponse("Forbidden", "Fellowship staff only", 403);
  }
  const statusParam = request.nextUrl.searchParams.get("status");
  const status =
    statusParam === "pending" ||
    statusParam === "reviewing" ||
    statusParam === "accepted" ||
    statusParam === "declined"
      ? (statusParam as AoFellowshipApplicationStatus)
      : undefined;
  const apps = await listAoFellowshipApplications(status ? { status } : undefined);
  return jsonResponse({
    success: true,
    applications: apps.map((a) => ({
      id: a.id,
      org_slug: a.orgSlug,
      org_name: a.orgName,
      sponsor_agent_id: a.sponsorAgentId,
      status: a.status,
      cycle_id: a.cycleId,
      created_at: a.createdAt,
    })),
  });
}
