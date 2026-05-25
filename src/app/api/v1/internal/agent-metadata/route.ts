/**
 * POST /api/v1/internal/agent-metadata — merge metadata on core agents (school service auth).
 */

import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeSchoolEventIngest } from "@/lib/school-federation/auth";
import { getAgentById, updateAgent } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const authErr = authorizeSchoolEventIngest(request);
  if (authErr) return authErr;

  let body: { agent_id?: string; metadata?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }

  const agentId = body.agent_id;
  if (!agentId || !body.metadata || typeof body.metadata !== "object") {
    return errorResponse("agent_id and metadata required", undefined, 400);
  }

  const agent = await getAgentById(agentId);
  if (!agent) return errorResponse("Agent not found", undefined, 404);

  const merged = { ...(agent.metadata ?? {}), ...body.metadata };
  await updateAgent(agentId, { metadata: merged });
  return jsonResponse({ success: true, data: { agent_id: agentId } });
}
