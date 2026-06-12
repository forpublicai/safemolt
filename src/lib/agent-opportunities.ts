/**
 * Canonical "agent opportunity" reads shared by the autonomous loop
 * (agent-loop.ts) and the /agents/me/home payload (agent-home/service.ts)
 * (M9/C8). Both surfaces previously re-implemented these gathers against the
 * same stores and had drifted — different membership sources, different
 * needs-action semantics. They now project their shapes from these snapshots;
 * intentional differences (limits, school scope) stay projection parameters.
 *
 * All gathers are error-tolerant: a failed read returns an empty snapshot so
 * neither the loop tick nor the home payload 500s on a single subsystem.
 */

import type { StoredGroup } from "@/lib/store-types";
import type { PlaygroundSession } from "@/lib/playground/types";
import {
  getPlaygroundActions,
  isGroupMember,
  listGroups,
  listPlaygroundSessions,
} from "@/lib/store";
import { listGames } from "@/lib/playground/games";
import { getNewsItems, type NewsItem } from "@/lib/rss";

// ---------------------------------------------------------------------------
// Playground
// ---------------------------------------------------------------------------

export interface PlaygroundPendingOpportunity {
  id: string;
  gameId: string;
  gameName: string;
  playerCount: number;
  /** From the game definition; 2 when the game is unknown to this deploy. */
  minPlayers: number;
  /** Whether this agent already sits in the lobby. */
  joined: boolean;
}

export interface PlaygroundActiveParticipation {
  id: string;
  gameId: string;
  gameName: string;
  /** A GM prompt is waiting on this round. */
  awaitingPrompt: boolean;
  /** Whether this agent already submitted an action for the current round. */
  hasActedThisRound: boolean;
  currentRoundPrompt: string | null;
}

export interface PlaygroundOpportunities {
  pending: PlaygroundPendingOpportunity[];
  /** Active sessions where this agent is an active participant. */
  active: PlaygroundActiveParticipation[];
}

export async function gatherPlaygroundOpportunities(
  agentId: string,
  opts: { pendingLimit?: number; activeLimit?: number } = {}
): Promise<PlaygroundOpportunities> {
  try {
    const [pendingSessions, activeSessions] = await Promise.all([
      listPlaygroundSessions({ status: "pending", limit: opts.pendingLimit ?? 3 }),
      listPlaygroundSessions({ status: "active", limit: opts.activeLimit ?? 5 }),
    ]);
    const gameMap = new Map(listGames().map((g) => [g.id, g]));
    const gameName = (gameId: string) => gameMap.get(gameId)?.name ?? gameId;

    const pending = pendingSessions.map((s: PlaygroundSession) => ({
      id: s.id,
      gameId: s.gameId,
      gameName: gameName(s.gameId),
      playerCount: s.participants.length,
      minPlayers: gameMap.get(s.gameId)?.minPlayers ?? 2,
      joined: s.participants.some((p) => p.agentId === agentId),
    }));

    const active: PlaygroundActiveParticipation[] = [];
    for (const s of activeSessions) {
      const isParticipant = s.participants.some(
        (p) => p.agentId === agentId && p.status === "active"
      );
      if (!isParticipant) continue;
      const roundActions = await getPlaygroundActions(s.id, s.currentRound);
      active.push({
        id: s.id,
        gameId: s.gameId,
        gameName: gameName(s.gameId),
        awaitingPrompt: Boolean(s.currentRoundPrompt),
        hasActedThisRound: roundActions.some((a) => a.agentId === agentId),
        currentRoundPrompt: s.currentRoundPrompt ?? null,
      });
    }

    return { pending, active };
  } catch {
    return { pending: [], active: [] };
  }
}

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface GroupOpportunities {
  joined: StoredGroup[];
  suggested: StoredGroup[];
}

/**
 * Membership comes from the canonical isGroupMember (group_members), never
 * the legacy member_ids snapshot — joinGroup does not maintain member_ids, so
 * filtering on it suggested groups the agent had already joined.
 */
export async function gatherGroupOpportunities(
  agentId: string,
  opts: { schoolId?: string; type?: "group" | "house"; suggestedLimit?: number } = {}
): Promise<GroupOpportunities> {
  try {
    const allGroups = await listGroups({ schoolId: opts.schoolId, type: opts.type });
    const membershipPairs = await Promise.all(
      allGroups.map(async (group) => {
        try {
          return [group, await isGroupMember(agentId, group.id)] as const;
        } catch (e) {
          console.error("[agent-opportunities] isGroupMember failed:", e);
          return [group, false] as const;
        }
      })
    );
    const joined = membershipPairs.filter(([, isMember]) => isMember).map(([group]) => group);
    const suggested = membershipPairs
      .filter(([, isMember]) => !isMember)
      .map(([group]) => group)
      .slice(0, opts.suggestedLimit ?? 5);
    return { joined, suggested };
  } catch (e) {
    console.error("[agent-opportunities] listGroups failed:", e);
    return { joined: [], suggested: [] };
  }
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export async function gatherNewsHeadlines(limit: number): Promise<NewsItem[]> {
  try {
    return await getNewsItems(limit);
  } catch {
    return [];
  }
}
