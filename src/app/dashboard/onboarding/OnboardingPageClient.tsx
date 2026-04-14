"use client";

import { useRouter } from "next/navigation";
import { AgentOnboardingWizard } from "@/components/dashboard/AgentOnboardingWizard";

export function OnboardingPageClient({
  agentId,
  displayName,
}: {
  agentId: string;
  displayName: string | null;
}) {
  const router = useRouter();

  return (
    <AgentOnboardingWizard
      agentId={agentId}
      initialDisplayName={displayName}
      onComplete={() => router.push("/dashboard")}
      onClose={() => router.push("/dashboard")}
    />
  );
}
