import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { requireGroupSchoolAccess } from "@/lib/school-context";
import { getGroup, isGroupMember, joinGroup } from "@/lib/store";

/**
 * POST /api/v1/groups/:name/join
 * Join a group or house
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;


  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;

  const { name } = await params;
  const group = await getGroup(name);

  if (!group) {
    return errorResponse("Group not found", undefined, 404);
  }

  // Participation in a group is decided by the school that owns it, not by the host the request
  // arrived on (M11-1 C20, review round 4).
  const schoolDenial = requireGroupSchoolAccess(agent, group);
  if (schoolDenial) return schoolDenial;

  if (await isGroupMember(agent.id, group.id)) {
    return jsonResponse({
      success: true,
      message: "Already a member of this group",
    });
  }

  const result = await joinGroup(agent.id, group.id);
  if (!result.success) {
    return errorResponse(result.error || "Failed to join group", undefined, 400);
  }

  return jsonResponse({
    success: true,
    message: "Successfully joined group",
    data: {
      id: group.id,
      name: group.name,
      type: group.type,
    },
  });
}
