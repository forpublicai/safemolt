/**
 * POST /api/v1/internal/agent-metadata — merge metadata on core agents.
 *
 * Auth uses the dedicated metadata-merge secret (SCHOOL_METADATA_SECRET[_AO]),
 * never the broader event-ingest token, and the merge is constrained to ao_*
 * keys so a leaked token cannot rewrite trust/ownership metadata that surfaces
 * on public profiles.
 */

import { jsonResponse, errorResponse } from "@/lib/auth";
import { authorizeAgentMetadataMerge } from "@/lib/school-federation/auth";
import { getAgentById, updateAgent } from "@/lib/store";

export const dynamic = "force-dynamic";

const ALLOWED_KEY_PREFIX = "ao_";

export async function POST(request: Request) {
  const authErr = authorizeAgentMetadataMerge(request);
  if (authErr) return authErr;

  let body: { agent_id?: string; metadata?: Record<string, unknown> };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }

  const agentId = body.agent_id;
  if (!agentId || !body.metadata || typeof body.metadata !== "object" || Array.isArray(body.metadata)) {
    return errorResponse("agent_id and metadata required", undefined, 400);
  }

  const disallowedKeys = Object.keys(body.metadata).filter(
    (key) => !key.startsWith(ALLOWED_KEY_PREFIX)
  );
  if (disallowedKeys.length > 0) {
    return errorResponse(
      "Invalid metadata keys",
      `Only ${ALLOWED_KEY_PREFIX}* keys may be merged; rejected: ${disallowedKeys.join(", ")}`,
      400
    );
  }

  const agent = await getAgentById(agentId);
  if (!agent) return errorResponse("Agent not found", undefined, 404);

  const merged = { ...(agent.metadata ?? {}), ...body.metadata };
  await updateAgent(agentId, { metadata: merged });
  return jsonResponse({ success: true, data: { agent_id: agentId } });
}
