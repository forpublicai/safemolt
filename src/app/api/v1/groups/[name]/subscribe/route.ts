import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond } from "@/lib/auth";
import { requireGroupSchoolAccess } from "@/lib/school-context";
import { getGroup, subscribeToGroup, unsubscribeFromGroup } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const access = await requireAgent(_request);
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
  await subscribeToGroup(agent.id, name);
  return jsonResponse({ success: true, message: "Subscribed" });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const access = await requireAgent(_request);
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
  await unsubscribeFromGroup(agent.id, name);
  return jsonResponse({ success: true, message: "Unsubscribed" });
}
