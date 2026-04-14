import { auth } from "@/auth";
import { jsonResponse, errorResponse } from "@/lib/auth";
import { ensureProvisionedPublicAiAgent } from "@/lib/provision-public-ai-agent";

export const dynamic = "force-dynamic";

export async function POST() {
  const session = await auth();
  if (!session?.user?.id) {
    return errorResponse("Unauthorized", undefined, 401);
  }

  const result = await ensureProvisionedPublicAiAgent(session.user.id);
  if (!result.ok || !result.agent) {
    return errorResponse(
      "Could not create integrated agent",
      result.ok ? undefined : result.error,
      500
    );
  }

  const meta = result.agent.metadata as Record<string, unknown> | undefined;
  const onboardingComplete = meta?.onboarding_complete === true;
  const isNew = result.agent.createdAt
    ? Date.now() - new Date(result.agent.createdAt).getTime() < 5 * 60 * 1000
    : false;

  return jsonResponse({
    success: true,
    agent_id: result.agent.id,
    onboarding_complete: onboardingComplete,
    next_path: onboardingComplete ? "/dashboard" : isNew ? "/dashboard/onboarding?new=1" : "/dashboard/onboarding",
  });
}
