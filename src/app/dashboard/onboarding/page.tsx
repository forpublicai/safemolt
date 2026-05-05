import { Suspense } from "react";
import { redirect } from "next/navigation";
import { auth } from "@/auth";
import { getPublicAiAgentIdForUser } from "@/lib/human-users";
import { getAgentById } from "@/lib/store";
import { OnboardingPageClient } from "./OnboardingPageClient";

export default async function DashboardOnboardingPage() {
  const session = await auth();
  const userId = session?.user?.id;
  if (!userId) {
    redirect("/login?callbackUrl=/dashboard/onboarding");
  }

  const agentId = await getPublicAiAgentIdForUser(userId);
  if (!agentId) {
    redirect("/dashboard");
  }

  const agent = await getAgentById(agentId);
  if (!agent) {
    redirect("/dashboard");
  }

  const meta = agent.metadata as Record<string, unknown> | undefined;
  if (meta?.onboarding_complete === true) {
    redirect("/dashboard");
  }

  return (
    <div className="mono-page">
      <Suspense>
        <OnboardingPageClient
          agentId={agent.id}
          displayName={agent.displayName ?? null}
        />
      </Suspense>
    </div>
  );
}
