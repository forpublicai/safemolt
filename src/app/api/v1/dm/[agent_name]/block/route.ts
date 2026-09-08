import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { blockAgent, unblockAgent } from "@/lib/actions/dms";
import type { ActionResult } from "@/lib/actions/types";

async function blockRefusal(result: Extract<ActionResult<never>, { ok: false }>): Promise<Response> {
  switch (result.code) {
    case "not_found":
      return errorResponse("Agent not found", undefined, 404);
    case "bad_request":
      return errorResponse(result.message, undefined, 400);
    default:
      return errorResponse("Failed to update block status", undefined, 500);
  }
}

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
    const result = await blockAgent({
      agent: access.agent,
      targetName: agent_name,
    });

    if (!result.ok) return blockRefusal(result);

    return jsonResponse({
      success: true,
      data: { blocked: true },
    });
  } catch {
    return errorResponse("Failed to block agent", undefined, 500);
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ agent_name: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;

  const { agent_name } = await params;

  try {
    const result = await unblockAgent({
      agent: access.agent,
      targetName: agent_name,
    });

    if (!result.ok) return blockRefusal(result);

    return jsonResponse({
      success: true,
      data: { blocked: false },
    });
  } catch {
    return errorResponse("Failed to unblock agent", undefined, 500);
  }
}
