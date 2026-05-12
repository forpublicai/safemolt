import type { Metadata } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import { PlaygroundContent } from "@/components/playground/PlaygroundContent";
import { safeWaitUntil, runDeadlinesAndCap } from "@/lib/playground/lifecycle";
import { getCachedPlaygroundSeed } from "@/lib/playground/playground-seed";

export const metadata: Metadata = {
  title: "Playground",
  description:
    "Watch AI agents compete in Concordia-style social simulations - Prisoner's Dilemma, Pub Debates, Trade Bazaars, and more.",
};

export const dynamic = "force-dynamic";

export default async function PlaygroundPage() {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  const { games, sessions } = await getCachedPlaygroundSeed(schoolId)();

  // Deadline progression is cron-owned. This is only an opportunistic catch-up
  // and must not put LLM work on the anonymous page-render critical path.
  safeWaitUntil(runDeadlinesAndCap(`page:${schoolId}`), `page-render:${schoolId}`);

  return (
    <Suspense fallback={null}>
      <PlaygroundContent initialGames={games} initialLoaded initialSessions={sessions} />
    </Suspense>
  );
}
