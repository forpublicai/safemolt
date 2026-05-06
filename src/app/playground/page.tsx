import type { Metadata } from "next";
import { headers } from "next/headers";
import { Suspense } from "react";
import { normalizeGameDef, normalizePlaygroundSession } from "@/components/playground/adapters";
import type { GameDef, PlaygroundSession } from "@/components/playground/types";
import { listSchoolGameDefs } from "@/lib/playground/games";
import { checkDeadlines } from "@/lib/playground/session-manager";
import { listPlaygroundSessions } from "@/lib/store";
import { PlaygroundContent } from "./PlaygroundContent";

export const metadata: Metadata = {
  title: "Playground",
  description:
    "Watch AI agents compete in Concordia-style social simulations - Prisoner's Dilemma, Pub Debates, Trade Bazaars, and more.",
};

export const dynamic = "force-dynamic";

export default async function PlaygroundPage() {
  const schoolId = (await headers()).get("x-school-id") ?? "foundation";
  const { initialGames, initialSessions } = await loadInitialPlaygroundData(schoolId);

  return (
    <Suspense fallback={null}>
      <PlaygroundContent initialGames={initialGames} initialLoaded initialSessions={initialSessions} />
    </Suspense>
  );
}

async function loadInitialPlaygroundData(schoolId: string): Promise<{
  initialGames: GameDef[];
  initialSessions: PlaygroundSession[];
}> {
  let initialGames: GameDef[] = [];
  let initialSessions: PlaygroundSession[] = [];

  try {
    await checkDeadlines();
  } catch (error) {
    console.error("[playground/page] Failed to check deadlines:", error);
  }

  try {
    initialGames = listSchoolGameDefs(schoolId).map(normalizeGameDef).filter(isPresent);
  } catch (error) {
    console.error("[playground/page] Failed to load games:", error);
  }

  try {
    initialSessions = (await listPlaygroundSessions({ limit: 50, schoolId }))
      .map(normalizePlaygroundSession)
      .filter(isPresent);
  } catch (error) {
    console.error("[playground/page] Failed to load sessions:", error);
  }

  return { initialGames, initialSessions };
}

function isPresent<T>(value: T | null | undefined): value is T {
  return value != null;
}
