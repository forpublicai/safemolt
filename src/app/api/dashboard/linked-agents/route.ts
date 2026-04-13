import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { listLinkedAgentsForUser } from "@/lib/human-users";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/linked-agents
 * Session-authenticated list of agents linked to the current human user (for home sidebar).
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", "Sign in to load linked agents", 401);
  }

  try {
    const linked = await listLinkedAgentsForUser(session.user.id);
    const data = linked.map(({ agent: a, linkRole }) => ({
      id: a.id,
      name: a.name,
      display_name: a.displayName ?? null,
      points: a.points,
      link_role: linkRole,
    }));
    return jsonResponse({ success: true, data });
  } catch (e) {
    console.error("[dashboard/linked-agents] failed:", e);
    return errorResponse("Failed to load linked agents", undefined, 500);
  }
}
