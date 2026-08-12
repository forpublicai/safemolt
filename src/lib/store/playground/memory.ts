import type { CancelPlaygroundOutcome, PlaygroundSession, CreateSessionInput, UpdateSessionInput, CreateActionInput, ResolutionMemory, SessionAction, SessionParticipant, PlaygroundSessionListOptions, SubmitActionOutcome } from '@/lib/playground/types';
import { PLAYGROUND_SYSTEM_EXPIRED_REASON } from '@/lib/playground/types';
import type { PreparedEvent } from "@/lib/events/kinds";
import { clearPlaygroundMemoriesForSession, writePlaygroundMemoryRecord } from './agent-memories-memory';
import { agents, playgroundActions, playgroundSessions } from "../_memory-state";
import {
  recordPlaygroundActionActivityEvent,
  recordPlaygroundSessionActivityEvent,
  writePlaygroundActionActivityProjectionInMemory,
  writePlaygroundSessionActivityProjectionInMemory,
} from "../activity/events";
import { appendPreparedBatch, prepareEventBatch, validatePreparedEvents } from "../events/memory";
import {
  mergeAffiliationIntoParticipant,
  type ActingJoinPatch,
} from "@/lib/playground/acting-affiliation";
import { PLAYGROUND_AFFILIATION_FIELDS } from "./db";
import type { PlaygroundJoinOutcome } from "./join-outcome";

/**
 * The memory twin of the db statements' `subject_id` override: the store's own session id.
 *
 * **Positional, on the PRIMARY event only** — the db side applies `overrides[0]` and leaves every
 * later event alone, whatever kind it is, so a kind-keyed rule here would agree for one event and
 * diverge for two. That divergence is the shape every primary+derived batch takes.
 */
function withSessionSubject(
  events: readonly PreparedEvent[] | undefined,
  sessionId: string
): PreparedEvent[] {
  return (events ?? []).map((event, index) =>
    index === 0 ? { ...event, subjectId: sessionId } : event
  );
}

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

export async function createPlaygroundSession(
  input: CreateSessionInput,
  events?: readonly PreparedEvent[]
) {
  const prepared = withSessionSubject(events, input.id);
  // Kind and payload FIRST, where the db statement renders — and before the eligibility check
  // below, because Postgres validates and serializes while it renders, which happens whether or not
  // the insert then matches. Uniqueness is the opposite and is left to `prepareEventBatch`.
  validatePreparedEvents(prepared);
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
  const batch = prepareEventBatch(prepared);
  // The synchronous section: the session and the append, with no `await` between them.
  playgroundSessions.set(input.id, session);
  const { stored, dispatched } = appendPreparedBatch(batch);
  // **The projection is part of the synchronous section** (u3d fix round, finding 2). Postgres gives
  // the db twin atomicity — the trail row is a CTE of the statement that wrote the session and
  // emitted the event — and memory mode has no transaction, so the equivalent is Decision 4's: no
  // `await` between the mutation, the append and the projection. The old shape awaited the dispatcher
  // first and then called the swallowing wrapper, so a failure there left the event appended with no
  // legacy projection and nothing to write it afterwards.
  writePlaygroundSessionActivityProjectionInMemory(session.id, { sourceEventId: stored[0]?.id });
  await dispatched;
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

/**
 * The memory twin of the cap-eligibility query — same predicate, same OLDEST-FIRST order.
 *
 * The db side documents why both halves matter: the age filter belongs in the query so a fixed
 * window cannot hide an overdue session behind newer ones, and `completedAt` is part of the
 * predicate so a row this returns always leaves the candidate set once the caller has processed it.
 */
export async function listSessionsDueForLifetimeCap(
  cutoff: string,
  limit: number
): Promise<PlaygroundSession[]> {
  const cutoffMs = Date.parse(cutoff);
  return Array.from(playgroundSessions.values())
    .filter((session) => {
      if (session.status !== 'active' || session.completedAt) return false;
      const startedAtMs = Date.parse(session.startedAt ?? session.createdAt);
      return Number.isFinite(startedAtMs) && startedAtMs <= cutoffMs;
    })
    .sort(
      (a, b) =>
        Date.parse(a.startedAt ?? a.createdAt) - Date.parse(b.startedAt ?? b.createdAt)
    )
    .slice(0, Math.max(1, Math.floor(limit)));
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
  reason: string,
  events?: readonly PreparedEvent[]
): Promise<CancelPlaygroundOutcome> {
  const prepared = withSessionSubject(events, sessionId);
  validatePreparedEvents(prepared);
  const session = playgroundSessions.get(sessionId);
  const isParticipant = session?.participants.some((p) => p.agentId === callerAgentId) ?? false;
  // Nonexistent and nonparticipant are deliberately the same answer (anti-probe).
  if (!session || !isParticipant) return { outcome: 'not_found' };
  if (session.status !== 'pending' && session.status !== 'active') {
    return { outcome: 'not_cancellable', status: session.status };
  }
  if (claimLive(session)) return { outcome: 'resolution_in_progress' };

  const previousStatus = session.status;
  const batch = prepareEventBatch(prepared);
  playgroundSessions.set(sessionId, {
    ...session,
    status: 'cancelled',
    cancelledAt: new Date().toISOString(),
    cancelledByAgentId: callerAgentId,
    cancelledReason: reason,
  });
  const { stored, dispatched } = appendPreparedBatch(batch);
  writePlaygroundSessionActivityProjectionInMemory(sessionId, { sourceEventId: stored[0]?.id });
  await dispatched;
  // Cancellation is a TRANSITION, so no FK cascade fires (M11-1 C3): episodic memories are swept
  // explicitly by the transition itself, in both stores (M11-1b D5).
  await clearPlaygroundMemoriesForSession(sessionId);
  return { outcome: 'cancelled', previousStatus };
}

/** Mirrors the db sweep: pending past the timeout → system-cancelled; anything else untouched. */
export async function expireStalePendingSessions(
  pendingTimeoutMs: number,
  events?: readonly PreparedEvent[]
): Promise<string[]> {
  // One event per expired session — the memory twin of the db fragment's `rowSource`, which emits
  // one row of the sweep, one event. The template's `subject_id` is replaced per session, so the
  // caller supplies ONE prepared event and the store fans it out.
  const template = events?.[0];
  validatePreparedEvents(events);
  const cutoff = Date.now() - pendingTimeoutMs;
  const expired: Array<{ id: string; eventId?: number }> = [];
  const dispatches: Promise<void>[] = [];
  for (const [id, session] of playgroundSessions) {
    if (session.status !== 'pending') continue;
    if (Date.parse(session.createdAt) > cutoff) continue;
    const batch = prepareEventBatch(template ? [{ ...template, subjectId: id }] : []);
    playgroundSessions.set(id, {
      ...session,
      status: 'cancelled',
      cancelledAt: new Date().toISOString(),
      cancelledByAgentId: null,
      cancelledReason: PLAYGROUND_SYSTEM_EXPIRED_REASON,
    });
    // Held, never dropped: the dispatcher cannot reject, and awaiting it inside the loop would put
    // an `await` between one session's mutation and the next one's decision.
    const { stored, dispatched } = appendPreparedBatch(batch);
    // Per session, in the same synchronous section as that session's own mutation and append — the
    // memory twin of the db fan-out, where one statement writes one trail row per expired row and
    // stamps each from its own event.
    writePlaygroundSessionActivityProjectionInMemory(id, { sourceEventId: stored[0]?.id });
    dispatches.push(dispatched);
    expired.push({ id });
  }
  await Promise.all(dispatches);
  return expired.map((row) => row.id);
}

/**
 * Join a pending playground session (memory store implementation).
 */
/**
 * The memory twin of the db store's single conditional join statement (M11-2 P1.4).
 *
 * Same two mutually exclusive branches, decided in ONE synchronous section — which is what the db
 * side gets from its `FOR UPDATE` and its single `UPDATE`. The order is Decision 4's: validate →
 * decide eligibility → return the refusal → preflight → mutate and append with no `await` between.
 *
 * **The refusal order matters and matches the statement's**: membership is checked BEFORE the
 * pending and capacity rules, because a member re-joining a session that has since activated is
 * `unchanged`, not "not pending" — the db `plan` decides `do_merge` from `is_member` alone.
 */
export async function joinPlaygroundSessionWithOutcome(
  sessionId: string,
  participant: SessionParticipant,
  maxPlayers: number,
  events?: {
    joined?: readonly PreparedEvent[];
    affiliationUpdated?: readonly PreparedEvent[];
  }
): Promise<PlaygroundJoinOutcome> {
  const joinedEvents = withSessionSubject(events?.joined, sessionId);
  const affiliationEvents = withSessionSubject(events?.affiliationUpdated, sessionId);
  validatePreparedEvents(joinedEvents);
  validatePreparedEvents(affiliationEvents);

  const session = playgroundSessions.get(sessionId);
  if (!session) return { result: 'refused', reason: 'Session not found' };

  const index = session.participants.findIndex((p) => p.agentId === participant.agentId);
  if (index < 0) {
    if (session.status !== 'pending') {
      return { result: 'refused', reason: 'Session not pending', session };
    }
    if (session.participants.length >= maxPlayers) {
      return { result: 'refused', reason: 'Session full', session };
    }
    const batch = prepareEventBatch(joinedEvents);
    const updated = { ...session, participants: [...session.participants, participant] };
    playgroundSessions.set(sessionId, updated);
    const { stored, dispatched } = appendPreparedBatch(batch);
    writePlaygroundSessionActivityProjectionInMemory(sessionId, { sourceEventId: stored[0]?.id });
    await dispatched;
    return { result: 'appended', session: updated };
  }

  // Already listed: the fill-if-empty refresh, and nothing else. Identical fields write nothing.
  const patch: ActingJoinPatch = {
    actingAsCompanyId: participant.actingAsCompanyId,
    actingAsLabel: participant.actingAsLabel,
    actingAsDisplaySummary: participant.actingAsDisplaySummary,
  };
  const { next, changed } = mergeAffiliationIntoParticipant(session.participants[index], patch);
  if (!changed) return { result: 'unchanged', session };

  const before = session.participants[index] as unknown as Record<string, unknown>;
  const after = next as unknown as Record<string, unknown>;
  // The db side diffs the element before and after, per field. Same diff, same sort order.
  const affiliationFields = PLAYGROUND_AFFILIATION_FIELDS.filter(
    (field) => (before[field] ?? '') !== (after[field] ?? '')
  )
    .slice()
    .sort();

  const batch = prepareEventBatch(
    affiliationEvents.map((event, position) =>
      position === 0
        ? { ...event, payload: { ...(event.payload as object), fields: affiliationFields } }
        : event
    ) as PreparedEvent[]
  );
  const participants = [...session.participants];
  participants[index] = next;
  const updated = { ...session, participants };
  playgroundSessions.set(sessionId, updated);
  const { stored, dispatched } = appendPreparedBatch(batch);
  writePlaygroundSessionActivityProjectionInMemory(sessionId, { sourceEventId: stored[0]?.id });
  await dispatched;
  return { result: 'affiliation_updated', session: updated, affiliationFields };
}

/** The `{ success, session?, reason? }` projection every pre-u3d caller and gate reads. */
export async function joinPlaygroundSession(
  sessionId: string,
  participant: SessionParticipant,
  maxPlayers: number,
  events?: {
    joined?: readonly PreparedEvent[];
    affiliationUpdated?: readonly PreparedEvent[];
  }
) {
  const outcome = await joinPlaygroundSessionWithOutcome(sessionId, participant, maxPlayers, events);
  return outcome.result === 'refused'
    ? { success: false, reason: outcome.reason }
    : { success: true, session: outcome.session };
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
export async function submitPlaygroundActionGated(
  input: CreateActionInput,
  events?: readonly PreparedEvent[]
): Promise<SubmitActionOutcome> {
  const prepared = withSessionSubject(events, input.sessionId);
  // Kind and payload first; the idempotency check is left to `prepareEventBatch` on the path that
  // actually writes. A REFUSED submission carrying the same `idem_key` as an accepted one is the
  // ordinary retry, and db mode answers it with a refusal rather than a 23505 — because the event
  // insert there is gated on the decisive CTE and never runs.
  validatePreparedEvents(prepared);
  const outcome = classifyActionRefusal(playgroundSessions.get(input.sessionId), input);
  if (!outcome.ok) return outcome;

  const batch = prepareEventBatch(prepared);
  // The synchronous section: the action row and the append, with no `await` between them.
  playgroundActions.set(input.id, outcome.action);
  const { stored, dispatched } = appendPreparedBatch(batch);
  writePlaygroundActionActivityProjectionInMemory(input.id, { sourceEventId: stored[0]?.id });
  await dispatched;
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
  memories: ResolutionMemory[] = [],
  events?: readonly PreparedEvent[]
) {
  const prepared = withSessionSubject(events, sessionId);
  validatePreparedEvents(prepared);
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

  const batch = prepareEventBatch(prepared);
  playgroundSessions.set(sessionId, updated);
  for (const record of deduped) {
    writePlaygroundMemoryRecord({ ...record, sessionId });
  }
  const { stored, dispatched } = appendPreparedBatch(batch);
  writePlaygroundSessionActivityProjectionInMemory(sessionId, { sourceEventId: stored[0]?.id });
  await dispatched;
  return true;
}

/**
 * The lifetime cap's conditional completion — the memory twin of the db statement's predicate.
 *
 * `updatePlaygroundSession` would have written whatever it found and answered `true` either way, so
 * a second sweep (or a sweep racing a genuine completion) would have emitted a second event for one
 * transition. The predicate is the gate here too.
 */
export async function completePlaygroundSessionAtLifetimeCap(
  sessionId: string,
  input: { summary: string; completedAt: string },
  events?: readonly PreparedEvent[]
): Promise<boolean> {
  const prepared = withSessionSubject(events, sessionId);
  validatePreparedEvents(prepared);
  const session = playgroundSessions.get(sessionId);
  if (!session || session.status !== 'active' || session.completedAt) return false;

  const batch = prepareEventBatch(prepared);
  playgroundSessions.set(sessionId, {
    ...session,
    status: 'completed',
    summary: session.summary ?? input.summary,
    completedAt: input.completedAt,
    currentRoundPrompt: undefined,
    roundDeadline: undefined,
  });
  const { stored, dispatched } = appendPreparedBatch(batch);
  writePlaygroundSessionActivityProjectionInMemory(sessionId, { sourceEventId: stored[0]?.id });
  await dispatched;
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
