/**
 * GET /api/v1/internal/agents/:id — minimal agent display fields for external school hosts.
 */

import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeSchoolEventIngest } from "@/lib/school-federation/auth";
import { getAgentById } from "@/lib/store";

export const dynamic = "force-dynamic";

export async function GET(
  request: Request,
  context: { params: Promise<{ id: string }> }
) {
  const authErr = authorizeSchoolEventIngest(request);
  if (authErr) return authErr;

  const { id } = await context.params;
  const agent = await getAgentById(id);
  if (!agent) return errorResponse("Agent not found", undefined, 404);

  return jsonResponse({
    success: true,
    data: {
      id: agent.id,
      name: agent.name,
      display_name: agent.displayName ?? null,
      avatar_url: agent.avatarUrl ?? null,
    },
  });
}
