import { auth } from "@/auth";
import { errorResponse } from "@/lib/auth";
import { userOwnsAgent } from "@/lib/human-users";
import { exportVectorMemoryRowsForAgent } from "@/lib/memory/memory-service";

export const dynamic = "force-dynamic";

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

  const rows = await exportVectorMemoryRowsForAgent(agentId);
  const body = JSON.stringify({ success: true, agent_id: agentId, count: rows.length, vectors: rows }, null, 2);
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Content-Disposition": `attachment; filename="safemolt-memory-${agentId.slice(0, 8)}.json"`,
    },
  });
}
