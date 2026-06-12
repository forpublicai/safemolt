
/**
 * Session Manager — orchestrates the async playground lifecycle.
 * All state is persisted in the DB. Functions are stateless and idempotent.
 */

import { generateRoundPrompt, resolveRound, generateSummary } from './engine';
import { pickRandomGame, getSchoolGameById, listSchoolGameDefs } from './games';
import { storeMemory } from './memory';
import { schedulePlaygroundMemoryIngest } from '@/lib/memory/platform-ingest';
import { getEmbedding } from './embeddings';
import { getRandomPrefab, getPrefab } from './prefabs';
import {
    enforceSessionLifetimeCap,
    revalidatePlaygroundSeed,
    safeWaitUntil,
    type PlaygroundDeadlineRunResult,
} from './lifecycle';
import type { PlaygroundGame, PlaygroundSession, SessionParticipant, SessionAction, TranscriptRound, CreateSessionInput, MemoryImportance } from './types';
import {
    sanitizeActingCompanyId,
    sanitizeActingLabel,
    resolveActingJoinPayload,
} from './acting-affiliation';

/** Resolve a game definition for a session (TS registry + YAML per school). */
function resolvePlaygroundGame(schoolId: string | undefined, gameId: string): PlaygroundGame | undefined {
    return getSchoolGameById(schoolId ?? 'foundation', gameId);
}

/** Default timeout per round in milliseconds (60 minutes) */
const ACTION_TIMEOUT_MS = 60 * 60 * 1000;

/** Timeout for pending sessions to find players (24 hours) */
const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/** Agents must have been active within this many days to be eligible */
const ACTIVITY_WINDOW_DAYS = 7;

// ============================================
// Lazy store import to avoid circular deps
// ============================================

async function getStore() {
    // Dynamic import to avoid circular dependency with store.ts
    const store = await import('../store');
    return store;
}

// ============================================
// Participant Selection
// ============================================

/**
 * Select eligible participants for a game.
 * Queries agents active within the last 7 days, shuffles, and picks
 * a count matching the game's player requirements.
 */
export async function selectParticipants(
    minPlayers: number,
    maxPlayers: number,
    candidates?: { id: string; name: string; displayName?: string }[]
): Promise<SessionParticipant[]> {
    const store = await getStore();
    const recentAgents = candidates ?? await store.getRecentlyActiveAgents(ACTIVITY_WINDOW_DAYS);

    if (recentAgents.length < minPlayers) {
        throw new Error(
            `Not enough active agents for this game. Need ${minPlayers}, found ${recentAgents.length} active in the last ${ACTIVITY_WINDOW_DAYS} days.`
        );
    }

    // Shuffle and pick
    const shuffled = [...recentAgents].sort(() => Math.random() - 0.5);
    const count = Math.min(maxPlayers, shuffled.length);
    const selected = shuffled.slice(0, count);

    return selected.map(agent => {
        // Assign a random prefab to each participant
        const prefab = getRandomPrefab();
        return {
            agentId: agent.id,
            agentName: agent.displayName || agent.name,
            status: 'active' as const,
            prefabId: prefab.id,
        };
    });
}

// ============================================
// Session Creation
// ============================================

/**
 * Create and start a new playground session.
 * Selects participants, generates round 1 prompt, stores everything in DB.
 */
export async function createAndStartSession(gameId?: string): Promise<PlaygroundSession> {
    const store = await getStore();

    // Check: is there already an active session?
    const activeSessions = await store.listPlaygroundSessions({ status: 'active', limit: 1 });
    if (activeSessions.length > 0) {
        throw new Error('There is already an active playground session. Wait for it to finish.');
    }

    // Pick or find the game
    let game;
    if (gameId) {
        game = getSchoolGameById('foundation', gameId);
        if (!game) {
            throw new Error(
                `Game "${gameId}" not found. Available: ${listSchoolGameDefs('foundation').map((g) => g.id).join(', ')}`
            );
        }
    }

    // Select participants (we need to know player count first)
    // Try to find eligible agents, then pick a game that fits
    const recentAgents = await store.getRecentlyActiveAgents(ACTIVITY_WINDOW_DAYS);

    if (!game) {
        game = pickRandomGame(recentAgents.length, 'foundation');
        if (!game) {
            throw new Error(
                `No suitable game for ${recentAgents.length} active agent(s). Need at least 2 active agents.`
            );
        }
    }

    // Game choice and participant choice draw from the same candidate list.
    const participants = await selectParticipants(game.minPlayers, game.maxPlayers, recentAgents);

    // Build initial session (without round prompt yet)
    const sessionId = generateId();
    const now = new Date().toISOString();
    const roundDeadline = new Date(Date.now() + ACTION_TIMEOUT_MS).toISOString();

    // Create a temporary session object for the engine
    const tempSession: PlaygroundSession = {
        id: sessionId,
        gameId: game.id,
        status: 'active',
        participants,
        transcript: [],
        currentRound: 1,
        maxRounds: game.defaultMaxRounds,
        createdAt: now,
        startedAt: now,
    };

    // Generate round 1 prompt via LLM
    const roundPrompt = await generateRoundPrompt(tempSession, game);

    // Persist to DB
    const sessionInput: CreateSessionInput = {
        id: sessionId,
        gameId: game.id,
        participants,
        maxRounds: game.defaultMaxRounds,
        currentRound: 1,
        currentRoundPrompt: roundPrompt,
        roundDeadline,
        status: 'active',
        startedAt: now,
        schoolId: 'foundation',
    };

    await store.createPlaygroundSession(sessionInput);

    return {
        ...tempSession,
        schoolId: 'foundation',
        currentRoundPrompt: roundPrompt,
        roundDeadline,
    };
}

/**
 * Create a new pending playground session that bots can join.
 */
export async function createPendingSession(gameId?: string, schoolId = 'foundation'): Promise<PlaygroundSession> {
    const store = await getStore();

    // Check: is there already an active or pending session for this school?
    const activeSessions = await store.listPlaygroundSessions({ status: 'active', limit: 1, schoolId });
    const pendingSessions = await store.listPlaygroundSessions({ status: 'pending', limit: 1, schoolId });

    if (activeSessions.length > 0 || pendingSessions.length > 0) {
        throw new Error('There is already an active or pending playground session. Wait for it to finish.');
    }

    // Pick a game (school-scoped)
    const game = gameId ? getSchoolGameById(schoolId, gameId) : pickRandomGame(4, schoolId);
    if (!game) throw new Error('No suitable game found');

    const sessionId = generateId();

    const sessionInput: CreateSessionInput = {
        id: sessionId,
        gameId: game.id,
        participants: [], // Start empty
        maxRounds: game.defaultMaxRounds,
        currentRound: 0,
        status: 'pending',
        schoolId,
    };

    await store.createPlaygroundSession(sessionInput);

    return (await store.getPlaygroundSession(sessionId))!;
}

/**
 * Join a pending playground session.
 * If minPlayers is reached, the session automatically starts.
 */
export async function joinSession(
    sessionId: string,
    agentId: string,
    actingBody?: {
        actingAsCompanyId?: string;
        actingAsLabel?: string;
        prefabId?: string;
    }
): Promise<PlaygroundSession> {
    const store = await getStore();

    // 1. Validate Agent
    const agent = await store.getAgentById(agentId);
    if (!agent) throw new Error('Agent not found');

    // 2. Validate Session & Game
    // We need to fetch session first to get gameId (for maxPlayers)
    const session = await store.getPlaygroundSession(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.status !== 'pending') throw new Error('Session is not in pending state');

    const schoolId = session.schoolId ?? 'foundation';
    const actingAsCompanyId = sanitizeActingCompanyId(actingBody?.actingAsCompanyId);
    const actingAsLabel = sanitizeActingLabel(actingBody?.actingAsLabel);

    const getAoCompanyForJoin = async (
        id: string
    ): Promise<{ id: string; name: string } | null> => {
        if (typeof store.getAoCompany === 'function') {
            try {
                return await store.getAoCompany(id);
            } catch {
                return null;
            }
        }
        return null;
    };

    const affiliationPayload = actingAsCompanyId ?? actingAsLabel
        ? await resolveActingJoinPayload({
              getAoCompany: getAoCompanyForJoin,
              actingAsCompanyId,
              actingAsLabel,
          })
        : {};

    if (
        Object.keys(affiliationPayload).length > 0 &&
        schoolId !== 'ao'
    ) {
        throw new Error(
            'acting_as_company_id / acting_as_label are only accepted on AO school playground sessions (ao.safemolt.com)'
        );
    }

    const game = resolvePlaygroundGame(session.schoolId, session.gameId);
    if (!game) throw new Error('Game definition not found');

    // 3. Prepare Participant
    const requestedPrefabId = actingBody?.prefabId?.trim();
    const prefab = requestedPrefabId ? getPrefab(requestedPrefabId) : getRandomPrefab();
    if (!prefab) {
        throw new Error('invalid_prefab_id');
    }
    const newParticipant: SessionParticipant = {
        agentId: agent.id,
        agentName: agent.displayName || agent.name,
        status: 'active',
        prefabId: prefab.id,
        ...affiliationPayload,
    };

    // 4. Atomic Join
    // This ensures we don't exceed maxPlayers and handles concurrent joins safely.
    const joinResult = await store.joinPlaygroundSession(sessionId, newParticipant, game.maxPlayers);

    if (!joinResult.success) {
        // If failed, it might be full or already joined or no longer pending
        throw new Error(joinResult.reason || 'Failed to join session');
    }

    let updatedSession = joinResult.session!;
    const patched = await store.mergePlaygroundParticipantAffiliationFields(
        sessionId,
        agent.id,
        affiliationPayload
    );
    if (patched) {
        updatedSession = patched;
    }

    // 5. Check Start Condition: if we hit minPlayers, attempt to activate.
    if (updatedSession.participants.length >= game.minPlayers) {
        await activateSession(updatedSession, game);
    }

    return updatedSession;
}

/**
 * Atomically flip a pending session to active round 1 and schedule round-1
 * prompt generation. activatePlaygroundSession guarantees only one caller
 * wins the flip (join vs. deadline scan). Prompt generation rides
 * safeWaitUntil — a bare fire-and-forget promise could be killed when the
 * serverless response returns, leaving a session active with no prompt.
 */
async function activateSession(session: PlaygroundSession, game: PlaygroundGame): Promise<boolean> {
    const store = await getStore();
    const now = new Date().toISOString();
    const roundDeadline = new Date(Date.now() + ACTION_TIMEOUT_MS).toISOString();

    const activated = await store.activatePlaygroundSession(session.id, 1, roundDeadline, now);
    if (!activated) return false;

    console.log(`[playground] Session ${session.id} started with ${session.participants.length} players. Generating prompt...`);

    const activeSession: PlaygroundSession = {
        ...session,
        status: 'active',
        currentRound: 1,
        startedAt: now,
        roundDeadline,
    };

    safeWaitUntil(
        generateRoundPrompt(activeSession, game).then(async (roundPrompt) => {
            await store.updatePlaygroundSession(session.id, { currentRoundPrompt: roundPrompt });
            console.log(`[playground] Round 1 prompt saved for session ${session.id}.`);
        }),
        `round1-prompt:${session.id}`
    );
    return true;
}


// ============================================
// Action Submission
// ============================================

/**
 * Submit an action for the current round.
 * Stores the action immediately and returns. GM resolution runs asynchronously
 * to prevent HTTP timeouts (SIGKILL) when the LLM takes 15-20s.
 */
export async function submitAction(
    sessionId: string,
    agentId: string,
    content: string
): Promise<PlaygroundSession> {
    const store = await getStore();

    const session = await store.getPlaygroundSession(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.status !== 'active') throw new Error('Session is not active');

    // Verify agent is a participant and not forfeited
    const participant = session.participants.find(p => p.agentId === agentId);
    if (!participant) throw new Error('Agent is not a participant in this session');
    if (participant.status === 'forfeited') throw new Error('Agent has been forfeited from this session');

    // Check if agent already submitted for this round
    const existingActions = await store.getPlaygroundActions(sessionId, session.currentRound);
    const alreadySubmitted = existingActions.some(a => a.agentId === agentId);
    if (alreadySubmitted) throw new Error('Agent already submitted an action for this round');

    // Store the action — idempotent via DB unique constraint (idx_pg_actions_unique)
    try {
        await store.createPlaygroundAction({
            id: generateId(),
            sessionId,
            agentId,
            round: session.currentRound,
            content,
        });
        const participantIds = session.participants.map((p) => p.agentId);
        schedulePlaygroundMemoryIngest(participantIds, content, {
            sessionId,
            round: session.currentRound,
            kind: 'playground_action',
            actorAgentId: agentId,
        });
    } catch (err: unknown) {
        // If this is a unique constraint violation, the action was already saved (race condition / retry)
        const errMsg = err instanceof Error ? err.message : String(err);
        if (errMsg.includes('unique') || errMsg.includes('duplicate')) {
            console.warn(`[playground] Duplicate action ignored for agent ${agentId} round ${session.currentRound}`);
            return session;
        }
        throw err;
    }


    // Fire-and-forget: trigger round advancement asynchronously.
    // This prevents the HTTP request from hanging while the GM LLM resolves.
    // safeWaitUntil keeps Vercel alive and falls back cleanly in local dev.
    safeWaitUntil(tryAdvanceRound(sessionId), `advance-round:${sessionId}`);

    // Return the session immediately (before GM resolution completes)
    return (await store.getPlaygroundSession(sessionId))!;
}

// ============================================
// Round Advancement (Core Async Logic)
// ============================================

interface RoundOutcome {
    /** Participants with grace-period / forfeit bookkeeping applied. */
    updatedParticipants: SessionParticipant[];
    /** Actions list for the GM (including forfeits). */
    roundActions: { agentId: string; agentName: string; content: string; forfeited: boolean }[];
    allForfeited: boolean;
}

/**
 * Pure round bookkeeping: apply the missed-round grace period (1st miss stays
 * active with an empty action; 2nd consecutive miss forfeits) and build the
 * GM-facing actions list.
 */
function computeRoundOutcome(
    session: PlaygroundSession,
    actions: SessionAction[]
): RoundOutcome {
    const submittedAgentIds = new Set(actions.map(a => a.agentId));

    const updatedParticipants = session.participants.map(p => {
        if (p.status !== 'active') return p;

        if (submittedAgentIds.has(p.agentId)) {
            return { ...p, missedRounds: 0 };
        }

        const newMissedRounds = (p.missedRounds ?? 0) + 1;
        if (newMissedRounds >= 2) {
            return { ...p, status: 'forfeited' as const, forfeitedAtRound: session.currentRound, missedRounds: newMissedRounds };
        }
        return { ...p, missedRounds: newMissedRounds };
    });

    const roundActions = updatedParticipants
        .filter(p => p.status === 'active' || p.forfeitedAtRound === session.currentRound)
        .map(p => {
            const action = actions.find(a => a.agentId === p.agentId);
            return {
                agentId: p.agentId,
                agentName: p.agentName,
                content: action?.content || '',
                forfeited: !action,
            };
        });

    return {
        updatedParticipants,
        roundActions,
        allForfeited: updatedParticipants.every(p => p.status !== 'active'),
    };
}

/**
 * The one terminal transition. Both completion paths (everyone forfeited and
 * normal max-rounds/game-over) run identical cleanup: summary generated from
 * the same transcript that is persisted, then a single terminal update that
 * clears the round prompt and deadline. (The forfeit path previously
 * summarized a transcript missing its final round.)
 */
async function completeSession(input: {
    session: PlaygroundSession;
    game: PlaygroundGame;
    participants: SessionParticipant[];
    transcript: TranscriptRound[];
}): Promise<PlaygroundSession> {
    const store = await getStore();
    const sessionForSummary: PlaygroundSession = {
        ...input.session,
        participants: input.participants,
        transcript: input.transcript,
    };
    const summary = await generateSummary(sessionForSummary, input.game);

    await store.updatePlaygroundSession(input.session.id, {
        status: 'completed',
        participants: input.participants,
        transcript: input.transcript,
        summary,
        completedAt: new Date().toISOString(),
        currentRoundPrompt: null,
        roundDeadline: null,
    });
    revalidatePlaygroundSeed(input.session.schoolId);

    return (await store.getPlaygroundSession(input.session.id))!;
}

/** Generate the next round's prompt and apply the advance as a single update. */
async function advanceToNextRound(input: {
    session: PlaygroundSession;
    game: PlaygroundGame;
    participants: SessionParticipant[];
    transcript: TranscriptRound[];
}): Promise<PlaygroundSession> {
    const store = await getStore();
    const nextRound = input.session.currentRound + 1;
    const nextSession: PlaygroundSession = {
        ...input.session,
        currentRound: nextRound,
        participants: input.participants,
        transcript: input.transcript,
    };

    const nextPrompt = await generateRoundPrompt(nextSession, input.game);
    const nextDeadline = new Date(Date.now() + ACTION_TIMEOUT_MS).toISOString();

    await store.updatePlaygroundSession(input.session.id, {
        participants: input.participants,
        transcript: input.transcript,
        currentRound: nextRound,
        currentRoundPrompt: nextPrompt,
        roundDeadline: nextDeadline,
    });

    return (await store.getPlaygroundSession(input.session.id))!;
}

/**
 * Try to advance the round for a session.
 * Checks if all active agents have submitted or if the deadline has passed.
 * If so: resolves the round, starts the next one (or ends the session).
 */
export async function tryAdvanceRound(sessionId: string): Promise<PlaygroundSession> {
    const store = await getStore();

    const session = await store.getPlaygroundSession(sessionId);
    if (!session || session.status !== 'active') {
        return session!;
    }

    const activeParticipants = session.participants.filter(p => p.status === 'active');
    const actions = await store.getPlaygroundActions(sessionId, session.currentRound);
    const submittedAgentIds = new Set(actions.map(a => a.agentId));

    const allSubmitted = activeParticipants.every(p => submittedAgentIds.has(p.agentId));
    const deadlinePassed = session.roundDeadline
        ? new Date(session.roundDeadline).getTime() <= Date.now()
        : false;

    if (!allSubmitted && !deadlinePassed) {
        // Not ready to advance yet
        return session;
    }

    const { updatedParticipants, roundActions, allForfeited } = computeRoundOutcome(session, actions);

    const game = resolvePlaygroundGame(session.schoolId, session.gameId);
    if (!game) {
        throw new Error(`Game "${session.gameId}" not found for school "${session.schoolId ?? 'foundation'}"`);
    }

    if (allForfeited) {
        // Everyone forfeited — end session early without a GM resolution call.
        // Kept as a separate branch (not a "synthetic resolution" through the
        // normal path) deliberately: the point is to skip the paid GM LLM call
        // and per-participant memory writes when nobody acted; both branches
        // still converge on the same completeSession.
        const forfeitRound: TranscriptRound = {
            round: session.currentRound,
            gmPrompt: session.currentRoundPrompt || '',
            actions: roundActions,
            gmResolution: 'All participants forfeited. Session ended early.',
            resolvedAt: new Date().toISOString(),
        };

        schedulePlaygroundMemoryIngest(updatedParticipants.map((p) => p.agentId), forfeitRound.gmResolution, {
            sessionId,
            round: session.currentRound,
            kind: 'playground_gm',
        });

        return completeSession({
            session,
            game,
            participants: updatedParticipants,
            transcript: [...session.transcript, forfeitRound],
        });
    }

    // Resolve the current round via GM
    const sessionForResolve: PlaygroundSession = { ...session, participants: updatedParticipants };
    const resolution = await resolveRound(sessionForResolve, game, roundActions);

    const newRound: TranscriptRound = {
        round: session.currentRound,
        gmPrompt: session.currentRoundPrompt || '',
        actions: roundActions,
        gmResolution: resolution.narration,
        resolvedAt: new Date().toISOString(),
    };

    const newTranscript = [...session.transcript, newRound];

    schedulePlaygroundMemoryIngest(updatedParticipants.map((p) => p.agentId), resolution.narration, {
        sessionId,
        round: session.currentRound,
        kind: 'playground_gm',
    });

    // Store memories for each participant after the round
    await storeRoundMemories(sessionId, newRound, updatedParticipants);

    // Max rounds reached OR game returned early termination (e.g. defection outcome)
    if (session.currentRound >= session.maxRounds || resolution.isGameOver) {
        return completeSession({
            session,
            game,
            participants: updatedParticipants,
            transcript: newTranscript,
        });
    }

    return advanceToNextRound({
        session,
        game,
        participants: updatedParticipants,
        transcript: newTranscript,
    });
}

// ============================================
// Active Session Query
// ============================================

/**
 * Get the active session for a specific agent, with info on whether they need to act.
 *
 * Priority order:
 *   1. Active session where agent needs to submit an action
 *   2. Active session where agent already responded (waiting for round resolution)
 *   3. Pending session where agent already joined (waiting for more players)
 *   4. Pending session the agent can join
 */
export async function getActiveSession(
    agentId: string
): Promise<{ session: PlaygroundSession; needsAction: boolean; currentPrompt: string; isPending?: boolean; needsActionSince?: string } | null> {
    const store = await getStore();

    // --- Active sessions --- (highest priority)
    const activeSessions = await store.listPlaygroundSessions({ status: 'active', limit: 10 });

    // 1. Active session where agent NEEDS to act (not yet submitted)
    for (const session of activeSessions) {
        const freshSession = await store.getPlaygroundSession(session.id);
        if (!freshSession || freshSession.status !== 'active') continue;

        const participant = freshSession.participants.find(p => p.agentId === agentId);
        if (!participant || participant.status !== 'active') continue;

        const actions = await store.getPlaygroundActions(freshSession.id, freshSession.currentRound);
        const alreadySubmitted = actions.some(a => a.agentId === agentId);

        if (!alreadySubmitted) {
            const roundDurationMs = 60 * 60 * 1000;
            const needsActionSince = freshSession.roundDeadline
                ? new Date(new Date(freshSession.roundDeadline).getTime() - roundDurationMs).toISOString()
                : new Date().toISOString();
            return {
                session: freshSession,
                needsAction: true,
                currentPrompt: freshSession.currentRoundPrompt || '',
                needsActionSince,
            };
        }
    }

    // 2. Active session where agent already responded (waiting for others / GM resolution)
    for (const session of activeSessions) {
        const freshSession = await store.getPlaygroundSession(session.id);
        if (!freshSession || freshSession.status !== 'active') continue;

        const participant = freshSession.participants.find(p => p.agentId === agentId);
        if (participant && participant.status === 'active') {
            return {
                session: freshSession,
                needsAction: false,
                currentPrompt: freshSession.currentRoundPrompt || '',
            };
        }
    }

    // --- Pending sessions --- (lower priority)
    const pendingSessions = await store.listPlaygroundSessions({ status: 'pending', limit: 10 });

    // 3. Pending session where agent already joined
    for (const session of pendingSessions) {
        const freshSession = await store.getPlaygroundSession(session.id);
        if (!freshSession || freshSession.status !== 'pending') continue;

        const isAlreadyIn = freshSession.participants.some(p => p.agentId === agentId);
        if (isAlreadyIn) {
            const game = resolvePlaygroundGame(freshSession.schoolId, freshSession.gameId);
            return {
                session: freshSession,
                needsAction: false,
                currentPrompt: `You've joined a "${game?.name || freshSession.gameId}" lobby. Waiting for more players...`,
                isPending: true,
            };
        }
    }

    // 4. Pending session the agent can join
    for (const session of pendingSessions) {
        const freshSession = await store.getPlaygroundSession(session.id);
        if (!freshSession || freshSession.status !== 'pending') continue;

        const game = resolvePlaygroundGame(freshSession.schoolId, freshSession.gameId);
        if (!game) continue;

        if (freshSession.participants.length < game.maxPlayers) {
            return {
                session: freshSession,
                needsAction: false,
                currentPrompt: `A new session of "${game.name}" is waiting for players. Would you like to join?`,
                isPending: true,
            };
        }
    }

    return null;
}

// ============================================
// Deadline Checker
// ============================================

/**
 * Check all active sessions for expired deadlines and advance them.
 * Called periodically (e.g., on any playground API hit or via cron).
 */
export async function checkDeadlines(): Promise<PlaygroundDeadlineRunResult> {
    const store = await getStore();
    let advanced = 0;
    const advanceStartedAt = performance.now();

    // 1. Advance active sessions
    const activeSessions = await store.listPlaygroundSessions({ status: 'active', limit: 50 });
    for (const session of activeSessions) {
        if (session.roundDeadline && new Date(session.roundDeadline).getTime() <= Date.now()) {
            try {
                await tryAdvanceRound(session.id);
                advanced += 1;
            } catch (err) {
                console.error(`[playground] Error advancing session ${session.id}:`, err);
            }
        }
    }
    const advanceDurationMs = performance.now() - advanceStartedAt;

    const capStartedAt = performance.now();
    const { completed: capped } = await enforceSessionLifetimeCap();
    const capDurationMs = performance.now() - capStartedAt;

    // 1b. Auto-activate pending sessions that have reached minPlayers
    try {
        const pendingToConsider = await store.listPlaygroundSessions({ status: 'pending', limit: 50 });
        for (const pending of pendingToConsider) {
            try {
                const fresh = await store.getPlaygroundSession(pending.id);
                if (!fresh || fresh.status !== 'pending') continue;

                const game = resolvePlaygroundGame(fresh.schoolId, fresh.gameId);
                if (!game) continue;

                const participantCount = (fresh.participants || []).length;
                if (participantCount >= game.minPlayers) {
                    await activateSession(fresh, game);
                }
            } catch (err) {
                console.error(`[playground] Error checking pending session ${pending.id}:`, err);
            }
        }
    } catch (err) {
        console.error('[playground] Error scanning pending sessions for activation:', err);
    }

    // 2. Delete stale pending sessions
    const pendingSessions = await store.listPlaygroundSessions({ status: 'pending', limit: 20 });
    for (const session of pendingSessions) {
        const ageMs = Date.now() - new Date(session.createdAt).getTime();
        if (ageMs >= PENDING_TIMEOUT_MS) {
            try {
                console.log(`[playground] Session ${session.id} expired in pending state. Deleting.`);
                await store.deletePlaygroundSession(session.id);
            } catch (err) {
                console.error(`[playground] Error deleting pending session ${session.id}:`, err);
            }
        }
    }

    return { advanced, capped, advanceDurationMs, capDurationMs };
}

// ============================================
// Daily Trigger
// ============================================

/**
 * Trigger the daily session. Skips if a session was already created today.
 * Now creates a PENDING session for agents to join.
 */
export async function triggerDaily(): Promise<PlaygroundSession | null> {
    const store = await getStore();

    // Check if a session was created today
    const todaySessions = await store.listPlaygroundSessions({ limit: 1 });
    if (todaySessions.length > 0) {
        const latestCreated = new Date(todaySessions[0].createdAt);
        const today = new Date();
        if (
            latestCreated.getUTCFullYear() === today.getUTCFullYear() &&
            latestCreated.getUTCMonth() === today.getUTCMonth() &&
            latestCreated.getUTCDate() === today.getUTCDate()
        ) {
            // Already created a session today
            return null;
        }
    }

    try {
        // Create a pending session instead of starting one immediately
        return await createPendingSession();
    } catch (err) {
        console.error('[playground] Daily trigger failed:', err);
        return null;
    }
}

// ============================================
// Helpers
// ============================================

function generateId(): string {
    return `pg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

// ============================================
// Memory Storage
// ============================================

/**
 * Determine memory importance based on round content
 */
function assessMemoryImportance(
    round: TranscriptRound,
    agentId: string
): MemoryImportance {
    // Check if agent participated in this round
    const agentAction = round.actions.find(a => a.agentId === agentId);

    // Check if resolution mentions the agent
    const mentionsAgent = round.gmResolution.toLowerCase().includes(agentId.toLowerCase());

    if (agentAction && mentionsAgent) {
        return 'high';
    }
    if (mentionsAgent) {
        return 'medium';
    }
    if (agentAction) {
        return 'low';
    }
    return 'low';
}

/**
 * Generate memory content from round resolution
 * Extracts the key event for each agent
 */
function generateMemoryContent(
    round: TranscriptRound,
    agentName: string,
    agentId: string
): string {
    const agentAction = round.actions.find(a => a.agentId === agentId);
    const actionContent = agentAction?.content || '[no action]';

    // Extract relevant part of resolution (first 200 chars as summary)
    const resolutionSummary = round.gmResolution.slice(0, 200);

    return `Round ${round.round}: I did "${actionContent}". GM noted: "${resolutionSummary}..."`;
}

/**
 * Store memories for all participants after a round is resolved
 */
async function storeRoundMemories(
    sessionId: string,
    round: TranscriptRound,
    participants: SessionParticipant[]
): Promise<void> {
    for (const participant of participants) {
        if (participant.status !== 'active') continue;

        const importance = assessMemoryImportance(round, participant.agentId);
        const content = generateMemoryContent(round, participant.agentName, participant.agentId);

        // Try to get embedding (optional - will fallback to text matching)
        let embedding: number[] | undefined;
        try {
            embedding = await getEmbedding(content);
        } catch {
            // Embedding failed - will use text matching instead
            console.log(`[playground] Embedding unavailable for memory, using text matching`);
        }

        await storeMemory({
            agentId: participant.agentId,
            agentName: participant.agentName,
            sessionId,
            content,
            embedding,
            importance,
            roundCreated: round.round,
        });
    }
}


