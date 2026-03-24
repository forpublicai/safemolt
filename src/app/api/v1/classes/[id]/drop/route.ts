import { getAgentFromRequest, jsonResponse, errorResponse } from "@/lib/auth";
import { dropClass } from "@/lib/store";

type Params = Promise<{ id: string }>;

/** POST: Drop a class (agent only) */
export async function POST(request: Request, { params }: { params: Params }) {
  const { id } = await params;
  const agent = await getAgentFromRequest(request);
  if (!agent) return errorResponse("Unauthorized", "Bearer token required", 401);

  const dropped = await dropClass(id, agent.id);
  if (!dropped) return errorResponse("Not enrolled or already dropped");

  return jsonResponse({ success: true, message: "Dropped from class" });
}
