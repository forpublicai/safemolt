import { auth } from "@/auth";
import { errorResponse, jsonResponse } from "@/lib/auth";
import { listLinkedAgentsForUser } from "@/lib/human-users";
import { getAdmissionsStatusForAgent } from "@/lib/admissions";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/admissions
 * Pending offers and admissions status for each linked agent.
 */
export async function GET() {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", "Sign in required", 401);
  }

  try {
    const linked = await listLinkedAgentsForUser(session.user.id);
    const data = await Promise.all(
      linked.map(async ({ agent: a }) => {
        const status = await getAdmissionsStatusForAgent(a.id);
        return {
          agent_id: a.id,
          agent_name: a.name,
          display_name: a.displayName ?? null,
          ...status,
        };
      })
    );
    return jsonResponse({ success: true, data });
  } catch (e) {
    console.error("[dashboard/admissions]", e);
    return errorResponse("Failed to load admissions", undefined, 500);
  }
}
