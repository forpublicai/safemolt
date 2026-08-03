import type { CancelPlaygroundOutcome, PlaygroundSession, CreateSessionInput, UpdateSessionInput, CreateActionInput, ResolutionMemory, SessionAction, SessionParticipant, PlaygroundSessionListOptions, SubmitActionOutcome } from '@/lib/playground/types';
import { PLAYGROUND_SYSTEM_EXPIRED_REASON } from '@/lib/playground/types';
import { clearPlaygroundMemoriesForSession, writePlaygroundMemoryRecord } from './agent-memories-memory';
import { agents, playgroundActions, playgroundSessions } from "../_memory-state";
import {
  recordPlaygroundActionActivityEvent,
  recordPlaygroundSessionActivityEvent,
} from "../activity/events";
import {
  mergeAffiliationIntoParticipant,
  type ActingJoinPatch,
} from "@/lib/playground/acting-affiliation";

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

/** Mirrors the db store: cancelled sessions are omitted from public agent history (C3). */
export async function getPlaygroundSessionsByAgentId(agentId: string, limit: number = 5) {
  return Array.from(playgroundSessions.values())
    .filter(
      (session) =>
        session.status !== 'cancelled' &&
        session.participants.some((participant) => participant.agentId === agentId)
    )
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

/** Same public contract as the list above: a cancelled session is not counted. */
export async function getPlaygroundSessionCountByAgentId(agentId: string) {
  return Array.from(playgroundSessions.values()).filter(
    (session) =>
      session.status !== 'cancelled' &&
      session.participants.some((participant) => participant.agentId === agentId)
  ).length;
}

export async function createPlaygroundSession(input: CreateSessionInput) {
  // M11-1 C23: one live session per school, mirrored from the db's partial unique index. The
  // check and the insert are one synchronous section; the same 23505 contract lets the caller
  // classify both stores' refusals identically.
  if (input.status === 'pending' || input.status === 'active') {
    const school = input.schoolId ?? 'foundation';
    for (const existing of playgroundSessions.values()) {
      if (
        (existing.status === 'pending' || existing.status === 'active') &&
        (existing.schoolId ?? 'foundation') === school
      ) {
        const err = new Error(`a live playground session exists for school '${school}'`) as Error & { code: string };
        err.code = '23505';
        throw err;
      }
    }
  }
  const now = new Date().toISOString();
  const session: PlaygroundSession = {
    id: input.id,
    gameId: input.gameId,
    schoolId: input.schoolId ?? 'foundation',
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
  await recordPlaygroundSessionActivityEvent(session.id);
  return session;
}

export async function getPlaygroundSession(id: string) {
  return playgroundSessions.get(id) ?? null;
}

export async function listPlaygroundSessions(options?: PlaygroundSessionListOptions) {
  let list = Array.from(playgroundSessions.values());
  if (options?.schoolId) {
    list = list.filter((s) => (s.schoolId ?? 'foundation') === options.schoolId);
  }
  if (options?.status) {
    list = list.filter(s => s.status === options.status);
  }
  list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  const offset = options?.offset ?? 0;
  const limit = options?.limit ?? 20;
  return list.slice(offset, offset + limit);
}

/** Field-by-field session merge shared by the plain update and the fenced apply (M11-1 C12). */
function mergeSessionUpdates(session: PlaygroundSession, updates: UpdateSessionInput): PlaygroundSession {
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
  return updated;
}

function activityWorthy(updates: UpdateSessionInput): boolean {
  return (
    updates.status !== undefined ||
    updates.participants !== undefined ||
    updates.currentRoundPrompt !== undefined ||
    updates.summary !== undefined ||
    updates.startedAt !== undefined ||
    updates.completedAt !== undefined
  );
}

export async function updatePlaygroundSession(id: string, updates: UpdateSessionInput) {
  const session = playgroundSessions.get(id);
  if (!session) return false;

  playgroundSessions.set(id, mergeSessionUpdates(session, updates));
  if (activityWorthy(updates)) {
    await recordPlaygroundSessionActivityEvent(id);
  }
  return true;
}

export async function deletePlaygroundSession(id: string) {
  return playgroundSessions.delete(id);
}

/**
 * M11-1 C3, memory mode — same decision rules as the db statement, in one synchronous section
 * (the old memory path removed the session outright, which under this design is simply wrong).
 */
export async function cancelPlaygroundSession(
  sessionId: string,
  callerAgentId: string,
  reason: string
): Promise<CancelPlaygroundOutcome> {
  const session = playgroundSessions.get(sessionId);
  const isParticipant = session?.participants.some((p) => p.agentId === callerAgentId) ?? false;
  // Nonexistent and nonparticipant are deliberately the same answer (anti-probe).
  if (!session || !isParticipant) return { outcome: 'not_found' };
  if (session.status !== 'pending' && session.status !== 'active') {
    return { outcome: 'not_cancellable', status: session.status };
  }
  if (claimLive(session)) return { outcome: 'resolution_in_progress' };

  const previousStatus = session.status;
  playgroundSessions.set(sessionId, {
    ...session,
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
    cancelledByAgentId: callerAgentId,
    cancelledReason: reason,
  });
  // Cancellation is a TRANSITION, so no FK cascade fires (M11-1 C3): episodic memories are swept
  // explicitly by the transition itself, in both stores (M11-1b D5).
  await clearPlaygroundMemoriesForSession(sessionId);
  await recordPlaygroundSessionActivityEvent(sessionId);
  return { outcome: 'cancelled', previousStatus };
}

/** Mirrors the db sweep: pending past the timeout → system-cancelled; anything else untouched. */
export async function expireStalePendingSessions(pendingTimeoutMs: number): Promise<string[]> {
  const cutoff = Date.now() - pendingTimeoutMs;
  const expired: string[] = [];
  for (const [id, session] of playgroundSessions) {
    if (session.status !== 'pending') continue;
    if (Date.parse(session.createdAt) > cutoff) continue;
    playgroundSessions.set(id, {
      ...session,
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancelledByAgentId: null,
      cancelledReason: PLAYGROUND_SYSTEM_EXPIRED_REASON,
    });
    expired.push(id);
  }
  for (const id of expired) {
    await recordPlaygroundSessionActivityEvent(id);
  }
  return expired;
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
  await recordPlaygroundSessionActivityEvent(sessionId);

  return { success: true, session: updated };
}

export async function mergePlaygroundParticipantAffiliationFields(
  sessionId: string,
  agentId: string,
  patch: ActingJoinPatch
): Promise<PlaygroundSession | null> {
  if (
    !patch.actingAsCompanyId?.trim() &&
    !patch.actingAsLabel?.trim() &&
    !patch.actingAsDisplaySummary?.trim()
  ) {
    return null;
  }

  const session = playgroundSessions.get(sessionId);
  if (!session) return null;
  const idx = session.participants.findIndex((p) => p.agentId === agentId);
  if (idx < 0) return null;

  const { next, changed } = mergeAffiliationIntoParticipant(session.participants[idx], patch);
  if (!changed) return null;

  const participants = [...session.participants];
  participants[idx] = next;
  const updated = { ...session, participants };
  playgroundSessions.set(sessionId, updated);
  await recordPlaygroundSessionActivityEvent(sessionId);
  return updated;
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
  await recordPlaygroundSessionActivityEvent(updated.id);
  return true;
}

export async function createPlaygroundAction(input: CreateActionInput) {
  const action: SessionAction = {
    ...input,
    createdAt: new Date().toISOString(),
  };
  playgroundActions.set(input.id, action);
  await recordPlaygroundActionActivityEvent(input.id);
  return action;
}

function claimLive(session: PlaygroundSession): boolean {
  return Boolean(
    session.resolveClaimToken &&
      session.resolveClaimExpiresAt &&
      Date.parse(session.resolveClaimExpiresAt) > Date.now()
  );
}

/** M11-1 C12: refusal classification shared by the sync gate below — one rule, stated once. */
function classifyActionRefusal(
  session: PlaygroundSession | undefined,
  input: CreateActionInput
): SubmitActionOutcome {
  if (!session) return { ok: false, reason: 'not_found' };
  if (session.status !== 'active') return { ok: false, reason: 'not_active' };
  const participant = session.participants.find((p) => p.agentId === input.agentId);
  if (!participant) return { ok: false, reason: 'not_participant' };
  if (participant.status === 'forfeited') return { ok: false, reason: 'forfeited' };
  if (session.currentRound !== input.round) return { ok: false, reason: 'stale_round' };
  const duplicate = Array.from(playgroundActions.values()).some(
    (a) => a.sessionId === input.sessionId && a.round === input.round && a.agentId === input.agentId
  );
  if (duplicate) return { ok: false, reason: 'duplicate' };
  if (claimLive(session)) return { ok: false, reason: 'resolving' };
  return { ok: true, action: { ...input, createdAt: new Date().toISOString() } };
}

/**
 * M11-1 C12, memory mode — decision and insert in ONE synchronous section (`playground/memory.ts`
 * used to write different ids blindly, so two concurrent calls could both capture an empty
 * snapshot). No `await` between the classification and the map write; the activity event follows.
 */
export async function submitPlaygroundActionGated(input: CreateActionInput): Promise<SubmitActionOutcome> {
  const outcome = classifyActionRefusal(playgroundSessions.get(input.sessionId), input);
  if (outcome.ok) {
    playgroundActions.set(input.id, outcome.action);
  }
  if (outcome.ok) {
    await recordPlaygroundActionActivityEvent(input.id);
  }
  return outcome;
}

export async function claimPlaygroundResolution(
  sessionId: string,
  round: number,
  token: string,
  leaseMs: number
) {
  const session = playgroundSessions.get(sessionId);
  if (!session || session.status !== 'active' || session.currentRound !== round) return false;
  if (claimLive(session)) return false;
  playgroundSessions.set(sessionId, {
    ...session,
    resolveClaimToken: token,
    resolveClaimExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
  });
  return true;
}

/** An expired lease cannot be renewed (M11-1b review round 2, B1) — see the db-side comment. */
export async function renewPlaygroundResolutionClaim(sessionId: string, token: string, leaseMs: number) {
  const session = playgroundSessions.get(sessionId);
  if (!session || session.resolveClaimToken !== token || !claimLive(session)) return false;
  playgroundSessions.set(sessionId, {
    ...session,
    resolveClaimExpiresAt: new Date(Date.now() + leaseMs).toISOString(),
  });
  return true;
}

/**
 * M11-1b D5 atomic follow-up, memory mode: the fence check, the session write and every
 * participant's memory happen in ONE synchronous section, mirroring the db's single statement. A
 * losing fence writes no memories, and a winning one cannot be observed half-written.
 */
export async function applyPlaygroundResolution(
  sessionId: string,
  fence: { round: number; token: string },
  updates: UpdateSessionInput,
  memories: ResolutionMemory[] = []
) {
  const session = playgroundSessions.get(sessionId);
  if (
    !session ||
    session.status !== 'active' ||
    session.currentRound !== fence.round ||
    session.resolveClaimToken !== fence.token ||
    // Lease liveness is part of the fence (M11-1b review B2): once a lease lapses the gated
    // insert admits new actions, so a stalled resolver committing its pre-action transcript would
    // silently drop a committed action. A lapsed lease loses; a reclaimer picks the round up.
    !claimLive(session)
  ) {
    return false;
  }

  // Settle the whole payload BEFORE touching either map. Db mode gets this from the statement
  // boundary: an unwritable row (a NULL in a NOT NULL column, an uncastable timestamp) aborts the
  // insert and rolls the advance back with it. Memory mode has no constraints, so without this it
  // would advance the session and then happily store the bad row — the two modes would disagree on
  // exactly the case the db-side rollback gate exists to pin.
  // The `agents` check mirrors the db's `JOIN live_agents`: a participant whose agent is gone
  // contributes no memory and cannot veto the advance.
  const writable = memories.filter((m) => agents.has(m.agentId));
  for (const record of writable) {
    assertStorableMemory(record);
  }
  // Last wins, matching the db payload's dedupe and this map's own overwrite semantics.
  const deduped = Array.from(new Map(writable.map((m) => [m.agentId, m])).values());

  const updated = mergeSessionUpdates(session, updates);
  updated.resolveClaimToken = null;
  updated.resolveClaimExpiresAt = null;

  playgroundSessions.set(sessionId, updated);
  for (const record of deduped) {
    writePlaygroundMemoryRecord({ ...record, sessionId });
  }
  await recordPlaygroundSessionActivityEvent(sessionId);
  return true;
}

/** The db's NOT NULL columns and its `created_at timestamptz` cast, as a memory-mode precondition. */
function assertStorableMemory(record: ResolutionMemory): void {
  for (const field of ['id', 'agentId', 'agentName', 'content', 'importance'] as const) {
    if (typeof record[field] !== 'string' || record[field].length === 0) {
      throw new Error(`playground memory ${field} must be a non-empty string`);
    }
  }
  if (Number.isNaN(Date.parse(record.createdAt))) {
    throw new Error('playground memory createdAt must be a valid timestamp');
  }
}

export async function getPlaygroundActions(sessionId: string, round: number) {
  return Array.from(playgroundActions.values())
    .filter(a => a.sessionId === sessionId && a.round === round)
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
}
