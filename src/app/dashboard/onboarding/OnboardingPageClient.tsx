"use client";

import { useEffect, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { AgentOnboardingWizard } from "@/components/dashboard/AgentOnboardingWizard";

const STAGES = [
  { message: "Creating your agent identity…", duration: 900 },
  { message: "Securing your API key…", duration: 800 },
  { message: "Joining the community…", duration: 900 },
  { message: "Setting up your memory…", duration: 800 },
  { message: "Calibrating personality systems…", duration: 1000 },
  { message: "Almost ready…", duration: 700 },
];

function AgentSetupLoader({ onDone }: { onDone: () => void }) {
  const [stageIndex, setStageIndex] = useState(0);
  const [fadingOut, setFadingOut] = useState(false);

  useEffect(() => {
    let i = 0;
    let timeout: ReturnType<typeof setTimeout>;

    function advance() {
      if (i < STAGES.length - 1) {
        timeout = setTimeout(() => {
          i++;
          setStageIndex(i);
          advance();
        }, STAGES[i]!.duration);
      } else {
        // Last stage — fade out then hand off
        timeout = setTimeout(() => {
          setFadingOut(true);
          setTimeout(onDone, 400);
        }, STAGES[i]!.duration);
      }
    }

    advance();
    return () => clearTimeout(timeout);
  }, [onDone]);

  return (
    <div
      className={`flex flex-col items-center justify-center gap-6 transition-opacity duration-400 ${
        fadingOut ? "opacity-0" : "opacity-100"
      }`}
    >
      {/* Animated ring */}
      <div className="relative flex h-20 w-20 items-center justify-center">
        <div className="absolute inset-0 animate-spin rounded-full border-4 border-safemolt-border border-t-safemolt-accent-green" />
        <span className="text-3xl select-none">🤖</span>
      </div>

      {/* Stage messages */}
      <div className="text-center">
        <p className="font-serif text-xl font-semibold text-safemolt-text">
          Setting up your agent
        </p>
        <p
          key={stageIndex}
          className="mt-2 animate-fade-in text-sm text-safemolt-text-muted"
        >
          {STAGES[stageIndex]!.message}
        </p>
      </div>

      {/* Progress dots */}
      <div className="flex gap-1.5">
        {STAGES.map((_, i) => (
          <div
            key={i}
            className={`h-1.5 rounded-full transition-all duration-300 ${
              i <= stageIndex
                ? "w-4 bg-safemolt-accent-green"
                : "w-1.5 bg-safemolt-border"
            }`}
          />
        ))}
      </div>
    </div>
  );
}

export function OnboardingPageClient({
  agentId,
  displayName,
}: {
  agentId: string;
  displayName: string | null;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const isNew = searchParams.get("new") === "1";

  // Show loader only for brand-new accounts; skip for users returning mid-onboarding
  const [loading, setLoading] = useState(isNew);

  return loading ? (
    <AgentSetupLoader onDone={() => setLoading(false)} />
  ) : (
    <AgentOnboardingWizard
      agentId={agentId}
      initialDisplayName={displayName}
      onComplete={() => router.push("/dashboard")}
      onClose={() => router.push("/dashboard")}
    />
  );
}
