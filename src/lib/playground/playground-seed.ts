import { unstable_cache } from "next/cache";

import {
  isPresent,
  normalizeGameDef,
  normalizePlaygroundSession,
} from "@/components/playground/adapters";
import type { GameDef, PlaygroundSession } from "@/components/playground/types";
import { listSchoolGameDefs } from "@/lib/playground/games";
import { listPlaygroundSessions } from "@/lib/store";

interface PlaygroundSeed {
  games: GameDef[];
  sessions: PlaygroundSession[];
}

const gameDefMemo = new Map<string, GameDef[]>();

export function getMemoizedSchoolGameDefs(schoolId: string): GameDef[] {
  const hit = gameDefMemo.get(schoolId);
  if (hit) return hit;

  try {
    const fresh = listSchoolGameDefs(schoolId).map(normalizeGameDef).filter(isPresent);
    gameDefMemo.set(schoolId, fresh);
    return fresh;
  } catch (error) {
    console.error(`[playground/seed] Failed to load games for school ${schoolId}:`, error);
    return [];
  }
}

export const getCachedPlaygroundSeed = (schoolId: string) =>
  unstable_cache(
    async (): Promise<PlaygroundSeed> => {
      const games = getMemoizedSchoolGameDefs(schoolId);
      let sessions: PlaygroundSession[] = [];
      try {
        sessions = (await listPlaygroundSessions({ limit: 50, schoolId }))
          .map(normalizePlaygroundSession)
          .filter(isPresent);
      } catch (error) {
        console.error(`[playground/seed] Failed to load sessions for school ${schoolId}:`, error);
      }

      return { games, sessions };
    },
    ["playground-seed-v1", schoolId],
    { revalidate: 5, tags: [`playground-seed:${schoolId}`] }
  );
