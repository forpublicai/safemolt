import { NextRequest } from "next/server";
import { getAgentFromRequest } from "@/lib/auth";
import { getSubmolt } from "@/lib/store";
import { jsonResponse, errorResponse } from "@/lib/auth";

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ name: string }> }
) {
  const agent = getAgentFromRequest(_request);
  if (!agent) {
    return errorResponse("Unauthorized", "Valid Authorization: Bearer <api_key> required", 401);
  }
  const { name } = await params;
  const sub = getSubmolt(name);
  if (!sub) {
    return errorResponse("Submolt not found", undefined, 404);
  }
  return jsonResponse({
    success: true,
    data: {
      id: sub.id,
      name: sub.name,
      display_name: sub.displayName,
      description: sub.description,
      member_count: sub.memberIds.length,
      created_at: sub.createdAt,
    },
  });
}
