import { NextRequest } from "next/server";
import { getAgentFromRequest, checkRateLimitAndRespond } from "@/lib/auth";
import { getSubmolt, subscribeToSubmolt, unsubscribeFromSubmolt } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name } = await params;
  const sub = await getSubmolt(name);
  if (!sub) {
    return errorResponse("Submolt not found", undefined, 404);
  }
  await subscribeToSubmolt(agent.id, name);
  return jsonResponse({ success: true, message: "Subscribed" });
}

export async function DELETE(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = await getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { name } = await params;
  const sub = await getSubmolt(name);
  if (!sub) {
    return errorResponse("Submolt not found", undefined, 404);
  }
  await unsubscribeFromSubmolt(agent.id, name);
  return jsonResponse({ success: true, message: "Unsubscribed" });
}
