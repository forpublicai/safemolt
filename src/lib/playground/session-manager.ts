import { waitUntil } from '@vercel/functions';

/**
 * Session Manager — orchestrates the async playground lifecycle.
 * All state is persisted in the DB. Functions are stateless and idempotent.
 */

import { generateRoundPrompt, resolveRound, generateSummary } from './engine';
import { getGame, pickRandomGame, listGames } from './games';
import { storeMemory } from './memory';
import { getEmbedding } from './embeddings';
import { getRandomPrefab, getPrefab } from './prefabs';
import { initializeWorldState, clearWorldState, setRelationship, addWorldEvent, getWorldState } from './world-state';
import { getAllComponents, createDefaultRegistry } from './components';
import { clearReasoningChain } from './components/reasoning-component';
import type {
    PlaygroundSession,
    SessionParticipant,
    TranscriptRound,
    CreateSessionInput,
    SessionAction,
    MemoryImportance,
    ComponentRegistry,
} from './types';

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
        startedAt: now,
    };

    await store.createPlaygroundSession(sessionInput);

    // Initialize world state for this session
    initializeWorldState(sessionId);

    // Initialize components for all participants
    const components = getAllComponents();
    for (const participant of participants) {
        for (const component of components) {
            try {
                await component.initialize(participant.agentId, sessionId);
            } catch (err) {
                console.error(`[playground] Error initializing component ${component.id} for agent ${participant.agentId}:`, err);
            }
        }
    }

    return {
        ...tempSession,
        currentRoundPrompt: roundPrompt,
        roundDeadline,
    };
}

/**
 * Create a new pending playground session that bots can join.
 */
export async function createPendingSession(gameId?: string): Promise<PlaygroundSession> {
    const store = await getStore();

    // Check: is there already an active or pending session?
    const activeSessions = await store.listPlaygroundSessions({ status: 'active', limit: 1 });
    const pendingSessions = await store.listPlaygroundSessions({ status: 'pending', limit: 1 });

    if (activeSessions.length > 0 || pendingSessions.length > 0) {
        throw new Error('There is already an active or pending playground session. Wait for it to finish.');
    }

    // Pick a game
    const game = gameId ? getGame(gameId) : pickRandomGame(4);
    if (!game) throw new Error('No suitable game found');

    const sessionId = generateId();

    const sessionInput: CreateSessionInput = {
        id: sessionId,
        gameId: game.id,
        participants: [], // Start empty
        maxRounds: game.defaultMaxRounds,
        currentRound: 0,
        status: 'pending',
    };

    await store.createPlaygroundSession(sessionInput);

    return (await store.getPlaygroundSession(sessionId))!;
}

/**
 * Join a pending playground session.
 * If minPlayers is reached, the session automatically starts.
 */
export async function joinSession(sessionId: string, agentId: string): Promise<PlaygroundSession> {
    const store = await getStore();

    // 1. Validate Agent
    const agent = await store.getAgentById(agentId);
    if (!agent) throw new Error('Agent not found');

    // 2. Validate Session & Game
    // We need to fetch session first to get gameId (for maxPlayers)
    const session = await store.getPlaygroundSession(sessionId);
    if (!session) throw new Error('Session not found');
    if (session.status !== 'pending') throw new Error('Session is not in pending state');

    const game = getGame(session.gameId);
    if (!game) throw new Error('Game definition not found');

    // 3. Prepare Participant
    const prefab = getRandomPrefab();
    const newParticipant: SessionParticipant = {
        agentId: agent.id,
        agentName: agent.displayName || agent.name,
        status: 'active',
        prefabId: prefab.id,
    };

    // 4. Atomic Join
    // This ensures we don't exceed maxPlayers and handles concurrent joins safely.
    const joinResult = await store.joinPlaygroundSession(sessionId, newParticipant, game.maxPlayers);

    if (!joinResult.success) {
        // If failed, it might be full or already joined or no longer pending
        throw new Error(joinResult.reason || 'Failed to join session');
    }

    const updatedSession = joinResult.session!;

    // 5. Check Start Condition
    // If we hit minPlayers, attempt to activate.
    // We use activatePlaygroundSession to ensure only ONE process triggers the start.
    if (updatedSession.participants.length >= game.minPlayers) {
        const now = new Date().toISOString();
        const roundDeadline = new Date(Date.now() + ACTION_TIMEOUT_MS).toISOString();

        const activated = await store.activatePlaygroundSession(sessionId, 1, roundDeadline, now);

        if (activated) {
            console.log(`[playground] Session ${sessionId} started with ${updatedSession.participants.length} players. Generating prompt...`);

            // Construct the active session object for prompt generation
            const activeSession: PlaygroundSession = {
                ...updatedSession,
                status: 'active',
                currentRound: 1,
                startedAt: now,
                roundDeadline,
            };

            // Fire-and-forget prompt generation
            generateRoundPrompt(activeSession, game)
                .then(async (roundPrompt) => {
                    await store.updatePlaygroundSession(sessionId, { currentRoundPrompt: roundPrompt });
                    console.log(`[playground] Round 1 prompt saved for session ${sessionId}.`);
                })
                .catch(err => {
                    console.error(`[playground] Failed to generate round prompt for ${sessionId}:`, err);
                });
        }
    }

    return updatedSession;
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
    // We use waitUntil so Vercel keeps the lambda alive.
    const advancePromise = tryAdvanceRound(sessionId).catch(err => {
        console.error(`[playground] Async tryAdvanceRound failed for session ${sessionId}:`, err);
    });
    waitUntil(advancePromise);

    // Return the session immediately (before GM resolution completes)
    return (await store.getPlaygroundSession(sessionId))!;
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

    // Grace period: track missed rounds instead of immediate forfeit
    // 1st miss: agent stays active, action defaults to empty
    // 2nd consecutive miss: agent is forfeited
    const updatedParticipants = session.participants.map(p => {
        if (p.status !== 'active') return p;

        if (submittedAgentIds.has(p.agentId)) {
            // Submitted — reset missed rounds counter
            return { ...p, missedRounds: 0 };
        }

        // Missed this round
        const newMissedRounds = (p.missedRounds ?? 0) + 1;
        if (newMissedRounds >= 2) {
            // 2nd consecutive miss — forfeit
            return { ...p, status: 'forfeited' as const, forfeitedAtRound: session.currentRound, missedRounds: newMissedRounds };
        }
        // 1st miss — grace period, stay active but action will be empty
        return { ...p, missedRounds: newMissedRounds };
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
            currentRoundPrompt: null,
            roundDeadline: null,
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
        gmResolution: resolution.narration,
        resolvedAt: new Date().toISOString(),
    };

    const newTranscript = [...session.transcript, newRound];

    // Store memories for each participant after the round
    await storeRoundMemories(sessionId, newRound, updatedParticipants);

    // Update world state (relationships, events) based on round resolution
    updateWorldStateFromRound(sessionId, newRound, updatedParticipants);

    // Check if we've reached max rounds OR game returned early termination (e.g. defection outcome)
    if (session.currentRound >= session.maxRounds || resolution.isGameOver) {
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
            currentRoundPrompt: null,
            roundDeadline: null,
        });

        // Clean up world state
        clearWorldState(sessionId);

        // Clean up reasoning chains
        clearReasoningChain(sessionId);

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
            const game = getGame(freshSession.gameId);
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

        const game = getGame(freshSession.gameId);
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
export async function checkDeadlines(): Promise<void> {
    const store = await getStore();

    // 1. Advance active sessions
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


/**
 * Update world state after each round based on GM resolution
 * Extracts relationship changes and key events from the narrative
 */
function updateWorldStateFromRound(
    sessionId: string,
    round: TranscriptRound,
    participants: SessionParticipant[]
): void {
    const resolution = round.gmResolution.toLowerCase();

    // Extract key events from the GM resolution
    const roundNum = round.round;

    // Detect trade/exchange mentions and update relationships
    const activeParticipants = participants.filter(p => p.status === 'active');

    // Simple heuristic: if agents are mentioned together in resolution, strengthen relationship
    for (let i = 0; i < activeParticipants.length; i++) {
        for (let j = i + 1; j < activeParticipants.length; j++) {
            const agent1 = activeParticipants[i];
            const agent2 = activeParticipants[j];

            const name1InResolution = resolution.includes(agent1.agentName.toLowerCase());
            const name2InResolution = resolution.includes(agent2.agentName.toLowerCase());

            if (name1InResolution && name2InResolution) {
                // Check for positive or negative interactions
                const positiveWords = ['cooperate', 'agree', 'trade', 'deal', 'alliance', 'help', 'support', 'accept', 'trust'];
                const negativeWords = ['betray', 'reject', 'refuse', 'conflict', 'dispute', 'defect', 'deny'];

                let relationshipChange = 10; // Default: interacting = positive

                for (const word of positiveWords) {
                    if (resolution.includes(word)) {
                        relationshipChange = 15;
                        break;
                    }
                }
                for (const word of negativeWords) {
                    if (resolution.includes(word)) {
                        relationshipChange = -15;
                        break;
                    }
                }

                // Get existing relationship or create new one
                const worldState = getWorldState(sessionId);
                if (worldState) {
                    const existingRel = worldState.relationships.find(
                        r => (r.agentId === agent1.agentId && r.otherAgentId === agent2.agentId) ||
                            (r.agentId === agent2.agentId && r.otherAgentId === agent1.agentId)
                    );

                    const newStrength = existingRel ? existingRel.strength + relationshipChange : relationshipChange;

                    setRelationship(sessionId, {
                        agentId: agent1.agentId,
                        otherAgentId: agent2.agentId,
                        type: newStrength > 30 ? 'trusted' : newStrength > 0 ? 'ally' : newStrength < -30 ? 'suspicious' : 'enemy',
                        strength: Math.max(-100, Math.min(100, newStrength)), // Clamp to -100 to 100
                        history: [`Round ${roundNum}: ${newStrength > 0 ? 'positive' : 'negative'} interaction`],
                    });
                }
            }
        }
    }

    // Add a world event for this round
    const eventDescription = resolution.slice(0, 150) + (resolution.length > 150 ? '...' : '');
    addWorldEvent(sessionId, {
        type: 'discovery' as const,
        description: eventDescription,
        participants: activeParticipants.map(p => p.agentId),
        round: roundNum,
        timestamp: new Date().toISOString(),
    });
}