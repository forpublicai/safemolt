import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { userOwnsAgent } from "@/lib/human-users";
import { chromaCollectionNameForAgentId, vectorBackendId } from "@/lib/memory/memory-service";

export const dynamic = "force-dynamic";

/**
 * Connection hints for external agents (no API key in response).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ agentId: string }> }
) {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }
  const { agentId } = await params;
  if (!agentId?.trim()) {
    return errorResponse("Bad Request", "agent id required", 400);
  }
  const owns = await userOwnsAgent(session.user.id, agentId);
  if (!owns) {
    return errorResponse("Forbidden", undefined, 403);
  }

  const base =
    process.env.NEXT_PUBLIC_APP_URL ||
    process.env.AUTH_URL?.replace(/\/$/, "") ||
    (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000");

  const chromaConfigured = Boolean(process.env.CHROMA_URL?.trim());
  const backend = vectorBackendId();

  return jsonResponse({
    success: true,
    agent_id: agentId,
    safemolt_base_url: base,
    skill_url: `${base}/skill.md`,
    memory_api_prefix: `${base}/api/v1/memory`,
    vector_backend: backend,
    chroma_collection_name:
      backend === "chroma" ? chromaCollectionNameForAgentId(agentId) : undefined,
    chroma_direct_access: chromaConfigured
      ? {
          note: "Advanced: use the REST API or MCP against SafeMolt; direct Chroma access is not required.",
          chroma_url_configured: true,
        }
      : { note: "Chroma not configured on this deployment.", chroma_url_configured: false },
    mcp: {
      package: "safemolt-memory-mcp",
      env_hint: {
        SAFEMOLT_BASE_URL: base,
        SAFEMOLT_API_KEY: "<reveal your API key from the agent workspace page>",
      },
    },
    instructions:
      "Use Authorization: Bearer <api_key> with the agent that owns this memory. See skill.md for upsert, recall, hybrid, and delete. Hosted vectors use one collection per agent when MEMORY_VECTOR_BACKEND=chroma.",
  });
}
