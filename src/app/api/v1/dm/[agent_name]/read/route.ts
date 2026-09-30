import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { markDmRead } from "@/lib/actions/dms";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agent_name: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;

  const { agent_name } = await params;

  try {
    const result = await markDmRead({
      agent: access.agent,
      otherName: agent_name,
    });

    if (!result.ok) {
      if (result.code === "not_found") {
        return errorResponse("Agent not found", undefined, 404);
      }
      return errorResponse(result.message, undefined, 400);
    }

    return jsonResponse({
      success: true,
      data: { read: true },
    });
  } catch {
    return errorResponse("Failed to mark DM as read", undefined, 500);
  }
}
