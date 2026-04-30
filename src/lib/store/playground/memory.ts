import type { PlaygroundSession, CreateSessionInput, UpdateSessionInput, CreateActionInput, SessionAction, SessionParticipant, PlaygroundSessionListOptions } from '@/lib/playground/types';
import { playgroundActions, playgroundSessions } from "../_memory-state";
import {
  logActivityEventWriteFailure,
  recordPlaygroundActionActivityEvent,
  recordPlaygroundSessionActivityEvent,
} from "../activity/events";

export async function listRecentPlaygroundActions(limit = 25) {
  return Array.from(playgroundActions.values())
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit)
    .map((a) => {
      const session = playgroundSessions.get(a.sessionId);
      return {
        id: a.id,
        sessionId: a.sessionId,
        agentId: a.agentId,
        round: a.round,
        content: a.content,
        createdAt: a.createdAt,
        gameId: session?.gameId ?? "playground",
        sessionStatus: session?.status ?? "unknown",
      };
    });
}

export async function getPlaygroundSessionsByAgentId(agentId: string, limit: number = 5) {
  return Array.from(playgroundSessions.values())
    .filter((session) => session.participants.some((participant) => participant.agentId === agentId))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

export async function getPlaygroundSessionCountByAgentId(agentId: string) {
  return Array.from(playgroundSessions.values()).filter((session) =>
    session.participants.some((participant) => participant.agentId === agentId)
  ).length;
}

export async function createPlaygroundSession(input: CreateSessionInput) {
  const now = new Date().toISOString();
  const session: PlaygroundSession = {
    id: input.id,
    gameId: input.gameId,
    status: input.status,
    participants: input.participants,
    transcript: [],
    currentRound: input.currentRound,
    currentRoundPrompt: input.currentRoundPrompt,
    roundDeadline: input.roundDeadline,
    maxRounds: input.maxRounds,
    createdAt: now,
    startedAt: input.startedAt || (input.status !== 'pending' ? now : undefined),
  };
  playgroundSessions.set(input.id, session);
  try {
    await recordPlaygroundSessionActivityEvent(session.id);
  } catch (error) {
    logActivityEventWriteFailure("playground_session", error);
  }
  return session;
}

export async function getPlaygroundSession(id: string) {
  return playgroundSessions.get(id) ?? null;
}

export async function listPlaygroundSessions(options?: PlaygroundSessionListOptions) {
  let list = Array.from(playgroundSessions.values());
  if (options?.status) {
    list = list.filter(s => s.status === options.status);
  }
  list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? 20;
  return list.slice(offset, offset + limit);
}

export async function updatePlaygroundSession(id: string, updates: UpdateSessionInput) {
  const session = playgroundSessions.get(id);
  if (!session) return false;

  const updated = { ...session };
  if (updates.status !== undefined) updated.status = updates.status;
  if (updates.participants !== undefined) updated.participants = updates.participants;
  if (updates.transcript !== undefined) updated.transcript = updates.transcript;
  if (updates.currentRound !== undefined) updated.currentRound = updates.currentRound;
  if (updates.currentRoundPrompt !== undefined) updated.currentRoundPrompt = updates.currentRoundPrompt === null ? undefined : updates.currentRoundPrompt;
  if (updates.roundDeadline !== undefined) updated.roundDeadline = updates.roundDeadline === null ? undefined : updates.roundDeadline;
  if (updates.summary !== undefined) updated.summary = updates.summary;
  if (updates.startedAt !== undefined) updated.startedAt = updates.startedAt;
  if (updates.completedAt !== undefined) updated.completedAt = updates.completedAt;

  playgroundSessions.set(id, updated);
  if (updates.startedAt) {
    try {
      await recordPlaygroundSessionActivityEvent(updated.id);
    } catch (error) {
      logActivityEventWriteFailure("playground_session", error);
    }
  }
  return true;
}

export async function deletePlaygroundSession(id: string) {
  return playgroundSessions.delete(id);
}

/**
 * Join a pending playground session (memory store implementation).
 */
export async function joinPlaygroundSession(
  sessionId: string,
  participant: SessionParticipant,
  maxPlayers: number) {
  const session = playgroundSessions.get(sessionId);

  if (!session) {
    return { success: false, reason: 'Session not found' };
  }

  if (session.status !== 'pending') {
    return { success: false, reason: 'Session not pending' };
  }

  // Check if already joined (idempotency)
  const alreadyJoined = session.participants.some(p => p.agentId === participant.agentId);
  if (alreadyJoined) {
    return { success: true, session };
  }

  // Check capacity
  if (session.participants.length >= maxPlayers) {
    return { success: false, reason: 'Session full' };
  }

  // Add participant
  const updatedParticipants = [...session.participants, participant];
  const updated = { ...session, participants: updatedParticipants };
  playgroundSessions.set(sessionId, updated);

  return { success: true, session: updated };
}

/**
 * Activate a pending playground session (memory store implementation).
 */
export async function activatePlaygroundSession(
  sessionId: string,
  currentRound: number,
  roundDeadline: string,
  startedAt: string) {
  const session = playgroundSessions.get(sessionId);

  if (!session) {
    return false;
  }

  if (session.status !== 'pending') {
    return false;
  }

  const updated: PlaygroundSession = {
    ...session,
    status: 'active',
    currentRound,
    roundDeadline,
    startedAt,
  };

  playgroundSessions.set(sessionId, updated);
  try {
    await recordPlaygroundSessionActivityEvent(updated.id);
  } catch (error) {
    logActivityEventWriteFailure("playground_session", error);
  }
  return true;
}

export async function createPlaygroundAction(input: CreateActionInput) {
  const action: SessionAction = {
    ...input,
    createdAt: new Date().toISOString(),
  };
  playgroundActions.set(input.id, action);
  try {
    await recordPlaygroundActionActivityEvent(input.id);
  } catch (error) {
    logActivityEventWriteFailure("playground_action", error);
  }
  return action;
}

export async function getPlaygroundActions(sessionId: string, round: number) {
  return Array.from(playgroundActions.values())
    .filter(a => a.sessionId === sessionId && a.round === round)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}
