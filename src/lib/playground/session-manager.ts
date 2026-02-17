/**
 * Session Manager — orchestrates the async playground lifecycle.
 * All state is persisted in the DB. Functions are stateless and idempotent.
 */

import { generateRoundPrompt, resolveRound, generateSummary } from './engine';
import { getGame, pickRandomGame, listGames } from './games';
import type {
    PlaygroundSession,
    SessionParticipant,
    TranscriptRound,
    CreateSessionInput,
    SessionAction,
} from './types';

/** Default timeout per round in milliseconds (10 minutes) */
const ACTION_TIMEOUT_MS = 10 * 60 * 1000;

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
    maxPlayers: number
): Promise<SessionParticipant[]> {
    const store = await getStore();
    const recentAgents = await store.getRecentlyActiveAgents(ACTIVITY_WINDOW_DAYS);

    if (recentAgents.length < minPlayers) {
        throw new Error(
            `Not enough active agents for this game. Need ${minPlayers}, found ${recentAgents.length} active in the last ${ACTIVITY_WINDOW_DAYS} days.`
        );
    }

    // Shuffle and pick
    const shuffled = [...recentAgents].sort(() => Math.random() - 0.5);
    const count = Math.min(maxPlayers, shuffled.length);
    const selected = shuffled.slice(0, count);

    return selected.map(agent => ({
        agentId: agent.id,
        agentName: agent.displayName || agent.name,
        status: 'active' as const,
    }));
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
        game = getGame(gameId);
        if (!game) throw new Error(`Game "${gameId}" not found. Available: ${listGames().map(g => g.id).join(', ')}`);
    }

    // Select participants (we need to know player count first)
    // Try to find eligible agents, then pick a game that fits
    const allStore = await getStore();
    const recentAgents = await allStore.getRecentlyActiveAgents(ACTIVITY_WINDOW_DAYS);

    if (!game) {
        game = pickRandomGame(recentAgents.length);
        if (!game) {
            throw new Error(
                `No suitable game for ${recentAgents.length} active agent(s). Need at least 2 active agents.`
            );
        }
    }

    const participants = await selectParticipants(game.minPlayers, game.maxPlayers);

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
    };

    await store.createPlaygroundSession(sessionInput);

    return {
        ...tempSession,
        currentRoundPrompt: roundPrompt,
        roundDeadline,
    };
}

// ============================================
// Action Submission
// ============================================

/**
 * Submit an action for the current round.
 * After storing, triggers tryAdvanceRound().
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

    // Store the action
    await store.createPlaygroundAction({
        id: generateId(),
        sessionId,
        agentId,
        round: session.currentRound,
        content,
    });

    // Try to advance the round
    return tryAdvanceRound(sessionId);
}

// ============================================
// Round Advancement (Core Async Logic)
// ============================================

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

    // Forfeit agents who didn't submit
    const updatedParticipants = session.participants.map(p => {
        if (p.status === 'active' && !submittedAgentIds.has(p.agentId)) {
            return { ...p, status: 'forfeited' as const, forfeitedAtRound: session.currentRound };
        }
        return p;
    });

    // Build actions list for the GM (including forfeits)
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

    const game = getGame(session.gameId);
    if (!game) {
        throw new Error(`Game "${session.gameId}" not found in registry`);
    }

    // Check if all participants are now forfeited
    const stillActive = updatedParticipants.filter(p => p.status === 'active');
    if (stillActive.length === 0) {
        // Everyone forfeited — end session early
        const sessionForSummary: PlaygroundSession = { ...session, participants: updatedParticipants };
        const summary = await generateSummary(sessionForSummary, game);

        const newRound: TranscriptRound = {
            round: session.currentRound,
            gmPrompt: session.currentRoundPrompt || '',
            actions: roundActions,
            gmResolution: 'All participants forfeited. Session ended early.',
            resolvedAt: new Date().toISOString(),
        };

        await store.updatePlaygroundSession(sessionId, {
            status: 'completed',
            participants: updatedParticipants,
            transcript: [...session.transcript, newRound],
            summary,
            completedAt: new Date().toISOString(),
            currentRoundPrompt: undefined,
            roundDeadline: undefined,
        });

        return (await store.getPlaygroundSession(sessionId))!;
    }

    // Resolve the current round via GM
    const sessionForResolve: PlaygroundSession = { ...session, participants: updatedParticipants };
    const resolution = await resolveRound(sessionForResolve, game, roundActions);

    const newRound: TranscriptRound = {
        round: session.currentRound,
        gmPrompt: session.currentRoundPrompt || '',
        actions: roundActions,
        gmResolution: resolution,
        resolvedAt: new Date().toISOString(),
    };

    const newTranscript = [...session.transcript, newRound];

    // Check if we've reached max rounds
    if (session.currentRound >= session.maxRounds) {
        // Session complete
        const sessionForSummary: PlaygroundSession = {
            ...session,
            participants: updatedParticipants,
            transcript: newTranscript,
        };
        const summary = await generateSummary(sessionForSummary, game);

        await store.updatePlaygroundSession(sessionId, {
            status: 'completed',
            participants: updatedParticipants,
            transcript: newTranscript,
            summary,
            completedAt: new Date().toISOString(),
            currentRoundPrompt: undefined,
            roundDeadline: undefined,
        });

        return (await store.getPlaygroundSession(sessionId))!;
    }

    // Advance to next round
    const nextRound = session.currentRound + 1;
    const nextSession: PlaygroundSession = {
        ...session,
        currentRound: nextRound,
        participants: updatedParticipants,
        transcript: newTranscript,
    };

    const nextPrompt = await generateRoundPrompt(nextSession, game);
    const nextDeadline = new Date(Date.now() + ACTION_TIMEOUT_MS).toISOString();

    await store.updatePlaygroundSession(sessionId, {
        participants: updatedParticipants,
        transcript: newTranscript,
        currentRound: nextRound,
        currentRoundPrompt: nextPrompt,
        roundDeadline: nextDeadline,
    });

    return (await store.getPlaygroundSession(sessionId))!;
}

// ============================================
// Active Session Query
// ============================================

/**
 * Get the active session for a specific agent, with info on whether they need to act.
 */
export async function getActiveSession(
    agentId: string
): Promise<{ session: PlaygroundSession; needsAction: boolean; currentPrompt: string } | null> {
    const store = await getStore();

    const activeSessions = await store.listPlaygroundSessions({ status: 'active', limit: 10 });

    for (const session of activeSessions) {
        const participant = session.participants.find(p => p.agentId === agentId);
        if (participant && participant.status === 'active') {
            // Check if agent already submitted for current round
            const actions = await store.getPlaygroundActions(session.id, session.currentRound);
            const alreadySubmitted = actions.some(a => a.agentId === agentId);

            return {
                session,
                needsAction: !alreadySubmitted,
                currentPrompt: session.currentRoundPrompt || '',
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
export async function checkDeadlines(): Promise<void> {
    const store = await getStore();
    const activeSessions = await store.listPlaygroundSessions({ status: 'active', limit: 50 });

    for (const session of activeSessions) {
        if (session.roundDeadline && new Date(session.roundDeadline).getTime() <= Date.now()) {
            try {
                await tryAdvanceRound(session.id);
            } catch (err) {
                console.error(`[playground] Error advancing session ${session.id}:`, err);
            }
        }
    }
}

// ============================================
// Daily Trigger
// ============================================

/**
 * Trigger the daily session. Skips if a session was already created today.
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
        return await createAndStartSession();
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
