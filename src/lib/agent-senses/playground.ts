/**
 * Playground lobbies the agent could join and active sessions it is playing.
 *
 * Promoted from `agent-opportunities.ts` (`gatherPlaygroundOpportunities`, M9 C8). The two lists
 * become one tagged `items` array so every section of the context has the same shape; the
 * semantics — per-round action awareness from `getPlaygroundActions`, joined-lobby flagging,
 * active-participant-only filtering — are unchanged.
 */

import { getPlaygroundActions, getPlaygroundSession, listPlaygroundSessions } from "@/lib/store";
import { listGames } from "@/lib/playground/games";
import type { PlaygroundSession } from "@/lib/playground/types";
import {
  DEFAULT_PLAYGROUND_ACTIVE_LIMIT,
  DEFAULT_PLAYGROUND_PENDING_LIMIT,
  DEFAULT_TRANSCRIPT_TAIL,
} from "./constants";
import type {
  PlaygroundActiveItem,
  PlaygroundItem,
  PlaygroundPendingItem,
  PlaygroundSection,
  PlaygroundTranscriptEntry,
} from "./types";

export interface GatherPlaygroundOptions {
  pendingLimit?: number;
  activeLimit?: number;
  /** Set by a `playground_round` focus: read exactly this session, with its transcript tail. */
  focusSessionId?: string;
}

interface GameFacts {
  name: (gameId: string) => string;
  minPlayers: (gameId: string) => number;
}

/** Game definitions are a process-local registry; a game this deploy does not know still renders. */
function readGameFacts(): GameFacts {
  const gameMap = new Map(listGames().map((g) => [g.id, g]));
  return {
    name: (gameId) => gameMap.get(gameId)?.name ?? gameId,
    minPlayers: (gameId) => gameMap.get(gameId)?.minPlayers ?? 2,
  };
}

function isActiveParticipant(session: PlaygroundSession, agentId: string): boolean {
  return session.participants.some((p) => p.agentId === agentId && p.status === "active");
}

function toPendingItem(
  session: PlaygroundSession,
  agentId: string,
  games: GameFacts
): PlaygroundPendingItem {
  return {
    kind: "pending",
    id: session.id,
    gameId: session.gameId,
    gameName: games.name(session.gameId),
    playerCount: session.participants.length,
    minPlayers: games.minPlayers(session.gameId),
    joined: session.participants.some((p) => p.agentId === agentId),
  };
}

async function toActiveItem(
  session: PlaygroundSession,
  agentId: string,
  games: GameFacts,
  transcriptTail?: PlaygroundTranscriptEntry[]
): Promise<PlaygroundActiveItem> {
  const roundActions = await getPlaygroundActions(session.id, session.currentRound);
  return {
    kind: "active",
    id: session.id,
    gameId: session.gameId,
    gameName: games.name(session.gameId),
    awaitingPrompt: Boolean(session.currentRoundPrompt),
    hasActedThisRound: roundActions.some((a) => a.agentId === agentId),
    currentRoundPrompt: session.currentRoundPrompt ?? null,
    ...(transcriptTail ? { transcriptTail } : {}),
  };
}

function transcriptTailOf(session: PlaygroundSession): PlaygroundTranscriptEntry[] {
  return (session.transcript ?? [])
    .slice(-DEFAULT_TRANSCRIPT_TAIL)
    .map((round) => ({
      round: round.round,
      gmPrompt: round.gmPrompt,
      gmResolution: round.gmResolution,
    }));
}

/** A `playground_round` focus: the one session the wakeup is about, plus its recent transcript. */
async function gatherFocusedSession(
  agentId: string,
  sessionId: string,
  games: GameFacts
): Promise<PlaygroundSection> {
  const session = await getPlaygroundSession(sessionId);
  // A missing session, or one this agent no longer plays, is a legitimate "nothing to do".
  if (!session || !isActiveParticipant(session, agentId)) {
    return { items: [], degraded: false };
  }
  const item = await toActiveItem(session, agentId, games, transcriptTailOf(session));
  return { items: [item], degraded: false };
}

export async function gatherPlayground(
  agentId: string,
  opts: GatherPlaygroundOptions = {}
): Promise<PlaygroundSection> {
  try {
    const games = readGameFacts();
    if (opts.focusSessionId) return await gatherFocusedSession(agentId, opts.focusSessionId, games);

    const [pendingSessions, activeSessions] = await Promise.all([
      listPlaygroundSessions({
        status: "pending",
        limit: opts.pendingLimit ?? DEFAULT_PLAYGROUND_PENDING_LIMIT,
      }),
      listPlaygroundSessions({
        status: "active",
        limit: opts.activeLimit ?? DEFAULT_PLAYGROUND_ACTIVE_LIMIT,
      }),
    ]);

    const items: PlaygroundItem[] = pendingSessions.map((s) => toPendingItem(s, agentId, games));
    for (const session of activeSessions) {
      if (!isActiveParticipant(session, agentId)) continue;
      items.push(await toActiveItem(session, agentId, games));
    }
    return { items, degraded: false };
  } catch (e) {
    console.error("[agent-senses] gatherPlayground failed:", e);
    return { items: [], degraded: true };
  }
}
