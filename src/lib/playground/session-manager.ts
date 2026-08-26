
/**
 * Session Manager — orchestrates the async playground lifecycle.
 * All state is persisted in the DB. Functions are stateless and idempotent.
 */

import { generateRoundPrompt, resolveRound, generateSummary } from './engine';
import { pickRandomGame, getSchoolGameById, listSchoolGameDefs } from './games';
import { prepareResolutionMemory } from './memory';
import { schedulePlaygroundMemoryIngest } from '@/lib/memory/platform-ingest';
import { getEmbedding } from './embeddings';
import { getRandomPrefab, getPrefab } from './prefabs';
import {
    enforceSessionLifetimeCap,
    revalidatePlaygroundSeed,
    safeWaitUntil,
    type PlaygroundDeadlineRunResult,
} from './lifecycle';
import type { PreparedEvent } from '@/lib/events/kinds';
import {
    playgroundRoundOpenedEvent,
    playgroundSessionCompletedEvent,
    playgroundSessionCreatedEvent,
    playgroundSessionExpiredEvent,
} from '@/lib/actions/playground-events';
import type { PlaygroundGame, PlaygroundSession, ResolutionMemory, SessionParticipant, SessionAction, SubmitActionRefusal, TranscriptRound, CreateSessionInput, MemoryImportance } from './types';
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

/**
 * M11-1 C12: resolution lease duration. Claimed before action enumeration and inference, renewed
 * at a third of this interval while the GM call runs, and every terminal write is fenced on the
 * claim token. The lease bounds the duplicate-billing residual (a claimant stalling past
 * lease+renewal can be reclaimed while its GM call is still in flight — at-most-one COMMIT is
 * guaranteed, exactly-once BILLING is not; release gate 7).
 */
const DEFAULT_RESOLVE_LEASE_MS = 2 * 60 * 1000;

function resolveLeaseMs(): number {
    const raw = (process.env.PLAYGROUND_RESOLVE_LEASE_MS || '').trim();
    if (!/^\d+$/.test(raw)) return DEFAULT_RESOLVE_LEASE_MS;
    const parsed = Number(raw);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : DEFAULT_RESOLVE_LEASE_MS;
}

/** Keep a held lease alive during long inference; stopped in the caller's finally. */
function startClaimRenewal(sessionId: string, token: string): { stop: () => void } {
    const leaseMs = resolveLeaseMs();
    const interval = setInterval(() => {
        void (async () => {
            try {
                const store = await getStore();
                await store.renewPlaygroundResolutionClaim(sessionId, token, leaseMs);
            } catch (err) {
                console.error(`[playground] lease renewal failed for ${sessionId}:`, err);
            }
        })();
    }, Math.max(1000, Math.floor(leaseMs / 3)));
    return { stop: () => clearInterval(interval) };
}

/** Timeout for pending sessions to find players (24 hours) */
const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;

/**
 * How long an active round-1 session may sit promptless before the sweep regenerates its prompt.
 * Normal round-1 generation completes in 15-20s (the GM-latency figure the submit path documents),
 * so two minutes is generous grace before assuming the async write crashed.
 */
const ROUND1_PROMPT_REPAIR_GRACE_MS = 2 * 60 * 1000;

/** How many due sessions one round-advance query returns, and how many such queries one sweep makes. */
const ROUND_ADVANCE_PAGE_SIZE = 50;
const ROUND_ADVANCE_MAX_PAGES = 20;

/** Bound on the pending-activation repair scan (u6 P3.1). A repair path, so one bounded call is enough. */
const PENDING_ACTIVATION_SCAN_LIMIT = 50;

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
export async function createAndStartSession(
    gameId?: string,
    events?: readonly PreparedEvent[]
): Promise<PlaygroundSession> {
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

    await store.createPlaygroundSession(sessionInput, events);

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
export async function createPendingSession(
    gameId?: string,
    schoolId = 'foundation',
    events?: readonly PreparedEvent[]
): Promise<PlaygroundSession> {
    const store = await getStore();

    // Friendly pre-check only (M11-1 C23): the constraint is the partial unique index over live
    // sessions per school, not this read.
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

    try {
        return await store.createPlaygroundSession(sessionInput, events);
    } catch (err) {
        // A concurrent trigger won the index. The loser receives the winner's session — the
        // caller's contract ("there is already a live session") just became true (M11-1 C23).
        if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
            const [live] = [
                ...(await store.listPlaygroundSessions({ status: 'pending', limit: 1, schoolId })),
                ...(await store.listPlaygroundSessions({ status: 'active', limit: 1, schoolId })),
            ];
            if (live) return live;
        }
        throw err;
    }
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
    },
    /**
     * The two branch events, decided by `actions/playground.joinSession` (M11-2 P1.4).
     *
     * Both are handed down together because only the store's single conditional statement knows
     * which branch it will take, and deciding that here would mean a pre-read — the exact shape the
     * restructure removed.
     */
    events?: {
        joined?: readonly PreparedEvent[];
        affiliationUpdated?: readonly PreparedEvent[];
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

    // 4. Atomic join — ONE statement for the append, the affiliation refresh and both events
    // (M11-2 P1.4). It used to be `joinPlaygroundSession` followed by a separate
    // `mergePlaygroundParticipantAffiliationFields`, which ran even when the append had no-opped:
    // two whole-column rewrites of the mutable `participants` JSONB, so a concurrent join committing
    // between them was erased even though it had returned success.
    const outcome = await store.joinPlaygroundSessionWithOutcome(
        sessionId,
        newParticipant,
        game.maxPlayers,
        events
    );

    if (outcome.result === 'refused' || !outcome.session) {
        // Full, no longer pending, or gone since the read above.
        throw new Error(outcome.reason || 'Failed to join session');
    }

    const updatedSession = outcome.session;

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
 *
 * M11-2 P3.2: the flip no longer claims a round deadline, and the prompt write is the CONDITIONAL
 * `storeRound1PromptIfMissing` carrying `playground.round_opened`. The two changes are one idea —
 * the round's clock and its event both belong to the write that durably publishes the prompt, so a
 * wakeup can never exist for a round nobody can act on, and a slow generation racing the repair
 * sweep cannot publish a second prompt or a second event.
 */
async function activateSession(session: PlaygroundSession, game: PlaygroundGame): Promise<boolean> {
    const store = await getStore();
    const now = new Date().toISOString();

    const activated = await store.activatePlaygroundSession(session.id, 1, now);
    if (!activated) return false;

    console.log(`[playground] Session ${session.id} started with ${session.participants.length} players. Generating prompt...`);

    // No roundDeadline yet: the clock starts when the prompt is durably stored, not before —
    // an active round-1 session promptless in this window is treated as un-expirable by every
    // deadline-scanning path (they all key off `roundDeadline` being set at all).
    const activeSession: PlaygroundSession = {
        ...session,
        status: 'active',
        currentRound: 1,
        startedAt: now,
    };

    safeWaitUntil(
        generateRoundPrompt(activeSession, game).then(async (roundPrompt) => {
            const stored = await store.storeRound1PromptIfMissing(session.id, roundPrompt, ACTION_TIMEOUT_MS, [
                playgroundRoundOpenedEvent({ sessionId: session.id, round: 1, schoolId: session.schoolId ?? null }),
            ]);
            if (stored) {
                console.log(`[playground] Round 1 prompt saved for session ${session.id}.`);
            } else {
                console.log(`[playground] Round 1 prompt for session ${session.id} was already stored (the repair sweep won this race); discarding this generation.`);
            }
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
/** Refusal reasons → the exact error copy callers already map to status codes. */
const SUBMIT_REFUSAL_MESSAGES: Record<SubmitActionRefusal, string> = {
    not_found: 'Session not found',
    not_active: 'Session is not active',
    not_participant: 'Agent is not a participant in this session',
    forfeited: 'Agent has been forfeited from this session',
    duplicate: 'Agent already submitted an action for this round',
    // Both are the action-vs-advance race, seen from either side of the CAS: the round the caller
    // read is being (or has been) resolved. New enumerated rejections (M11-1 C12).
    stale_round: 'Round already resolved. Wait for the next round.',
    resolving: 'Round is being resolved. Wait for the next round.',
};

/**
 * M11-1 C12: the checks below are *friendly* — the decisive verification lives inside the store's
 * gated insert, which re-verifies live status, current round, active membership, no duplicate,
 * and no in-flight resolution claim, with the session row locked. Both surfaces (route and tool)
 * come through here, which is what makes tool actions ingest memory and advance rounds exactly
 * like route actions.
 */
export async function submitAction(
    sessionId: string,
    agentId: string,
    content: string,
    /**
     * The event, as a function of the ROUND (M11-2 P1.4).
     *
     * A function rather than a value because the round is not knowable to the action: it comes from
     * the session this service reads, and both the payload triple and the `idem_key` name it. An
     * action that supplied a round from its own pre-read would stamp a key for a round that had
     * already moved — and the idem key is precisely what must not be wrong.
     */
    events?: (round: number) => readonly PreparedEvent[]
): Promise<{ session: PlaygroundSession; action: SessionAction }> {
    const store = await getStore();

    const session = await store.getPlaygroundSession(sessionId);
    if (!session) throw new Error(SUBMIT_REFUSAL_MESSAGES.not_found);
    if (session.status !== 'active') throw new Error(SUBMIT_REFUSAL_MESSAGES.not_active);

    const outcome = await store.submitPlaygroundActionGated(
        {
            id: generateId(),
            sessionId,
            agentId,
            round: session.currentRound,
            content,
        },
        events?.(session.currentRound)
    );
    if (!outcome.ok) throw new Error(SUBMIT_REFUSAL_MESSAGES[outcome.reason]);

    const participantIds = session.participants.map((p) => p.agentId);
    schedulePlaygroundMemoryIngest(participantIds, content, {
        sessionId,
        round: outcome.action.round,
        kind: 'playground_action',
        actorAgentId: agentId,
        // M11-1b D5: the created action's own row id, so same-round actions by different agents
        // cannot collide on one chunk id and overwrite each other in recipients' vector stores.
        // `submitAction` used to discard this id; the gated insert returns it.
        actionId: outcome.action.id,
    });

    // Fire-and-forget: trigger round advancement asynchronously.
    // This prevents the HTTP request from hanging while the GM LLM resolves.
    // safeWaitUntil keeps Vercel alive and falls back cleanly in local dev.
    safeWaitUntil(tryAdvanceRound(sessionId), `advance-round:${sessionId}`);

    // Return the session immediately (before GM resolution completes)
    return { session: (await store.getPlaygroundSession(sessionId))!, action: outcome.action };
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
 * What a fenced resolution write returned: whether THIS resolver's CAS won, and the session as it
 * stands afterwards. The two are separate because a loser still returns a valid session — the one
 * the winner wrote — and the caller must not mistake that for its own success and go on to
 * schedule external work off it.
 */
type ResolutionOutcome = { won: boolean; session: PlaygroundSession };

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
    fence: { round: number; token: string };
    memories: ResolutionMemory[];
}): Promise<ResolutionOutcome> {
    const store = await getStore();
    const sessionForSummary: PlaygroundSession = {
        ...input.session,
        participants: input.participants,
        transcript: input.transcript,
    };
    const summary = await generateSummary(sessionForSummary, input.game);

    const won = await store.applyPlaygroundResolution(
        input.session.id,
        input.fence,
        {
            status: 'completed',
            participants: input.participants,
            transcript: input.transcript,
            summary,
            completedAt: new Date().toISOString(),
            currentRoundPrompt: null,
            roundDeadline: null,
        },
        input.memories,
        // Gated on the CAS: a resolver that lost its lease completes nothing and emits nothing.
        // `advanceToNextRound` passes NO events at all — `playground.round_resolved` is not in this
        // build's kind union, and a kind may not be emitted before every consumer knows it.
        [
            playgroundSessionCompletedEvent({
                sessionId: input.session.id,
                schoolId: input.session.schoolId ?? null,
                reason: 'resolution',
            }),
        ]
    );
    if (!won) {
        // Token fence rejected the write: a reclaimer already resolved this round. Discard —
        // including this round's memories, which the same statement declined to write.
        console.warn(`[playground] completion for ${input.session.id} round ${input.fence.round} lost its claim; result discarded`);
        return { won: false, session: (await store.getPlaygroundSession(input.session.id))! };
    }
    revalidatePlaygroundSeed(input.session.schoolId);

    return { won: true, session: (await store.getPlaygroundSession(input.session.id))! };
}

/** Generate the next round's prompt and apply the advance — and the round's memories — as one
 *  fenced statement. */
async function advanceToNextRound(input: {
    session: PlaygroundSession;
    game: PlaygroundGame;
    participants: SessionParticipant[];
    transcript: TranscriptRound[];
    fence: { round: number; token: string };
    memories: ResolutionMemory[];
}): Promise<ResolutionOutcome> {
    const store = await getStore();
    const nextRound = input.session.currentRound + 1;
    const nextSession: PlaygroundSession = {
        ...input.session,
        currentRound: nextRound,
        participants: input.participants,
        transcript: input.transcript,
    };

    // The round's memories are passed in, not yet stored: the CAS below writes them. Without this
    // the next round's GM would read the store and see the memories of the round BEFORE last,
    // because the D5 atomic follow-up moved the write after this prompt.
    const nextPrompt = await generateRoundPrompt(nextSession, input.game, input.memories);
    const nextDeadline = new Date(Date.now() + ACTION_TIMEOUT_MS).toISOString();

    const won = await store.applyPlaygroundResolution(
        input.session.id,
        input.fence,
        {
            participants: input.participants,
            transcript: input.transcript,
            currentRound: nextRound,
            currentRoundPrompt: nextPrompt,
            roundDeadline: nextDeadline,
        },
        input.memories,
        // M11-2 P3.2: rounds >= 2 open through this CAS, which already carries the prompt — so the
        // event rides the write that publishes it, and the LOSER of an advance race writes nothing
        // and emits nothing. Two racers each emitting would produce two distinct event ids, which
        // pass the wakeup queue's `(agent, reason, event_id)` dedup and hand every participant two
        // turns for one round.
        [
            playgroundRoundOpenedEvent({
                sessionId: input.session.id,
                round: nextRound,
                schoolId: input.session.schoolId ?? null,
            }),
        ]
    );
    if (!won) {
        console.warn(`[playground] advancement for ${input.session.id} round ${input.fence.round} lost its claim; result discarded`);
    }

    return { won, session: (await store.getPlaygroundSession(input.session.id))! };
}

/**
 * Try to advance the round for a session.
 * Checks if all active agents have submitted or if the deadline has passed.
 *
 * M11-1 C12: resolution runs under a durable per-(session, round) lease. The claim is taken
 * BEFORE actions are enumerated and before inference (so the transcript can never silently drop
 * an action that landed after an unclaimed read), renewed during the GM call, and both terminal
 * writes go through the (status, current_round, token) CAS. A concurrent caller that loses the
 * claim returns without invoking the GM — that is what closes the duplicate-billing path from
 * concurrent unauthenticated session GETs. What the lease does NOT guarantee is exactly-once
 * external billing: a claimant stalled past its lease can be reclaimed while its GM call is in
 * flight; the fence rejects its WRITE, not its SPEND (release gate 7).
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

    const token = `resolve_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
    const claimed = await store.claimPlaygroundResolution(sessionId, session.currentRound, token, resolveLeaseMs());
    if (!claimed) {
        // Another resolver holds a live lease (or the round already moved). Spend nothing.
        return (await store.getPlaygroundSession(sessionId))!;
    }

    const renewal = startClaimRenewal(sessionId, token);
    try {
        return await resolveClaimedRound(sessionId, { round: session.currentRound, token });
    } finally {
        renewal.stop();
    }
}

/**
 * Advisory, never decisive — the terminal CAS is what settles a round. This exists so a resolver
 * that has already lost its lease stops before buying work it cannot commit: the embeddings, and
 * the second inference call (the next round's prompt, or the summary). The pre-follow-up shape got
 * this for free, because the lease-gated memory write sat between them and returned false.
 *
 * Renewing rather than merely reading is deliberate: an expired lease cannot be renewed, so this
 * still refuses a lapsed claimant, and a live one buys the expensive call a fresh lease to finish
 * inside instead of racing the interval renewal.
 */
async function stillOwnsClaim(
    store: Awaited<ReturnType<typeof getStore>>,
    sessionId: string,
    fence: { round: number; token: string }
): Promise<boolean> {
    if (await store.renewPlaygroundResolutionClaim(sessionId, fence.token, resolveLeaseMs())) return true;
    console.warn(`[playground] resolution for ${sessionId} round ${fence.round} lost its claim; spending nothing further`);
    return false;
}

/**
 * Everyone forfeited — end the session early without a GM resolution call.
 *
 * Kept as a separate branch (not a "synthetic resolution" through the normal path) deliberately:
 * the point is to skip the paid GM LLM call and the per-participant memory writes when nobody
 * acted. Both branches still converge on the same `completeSession`.
 */
async function completeAllForfeited(input: {
    session: PlaygroundSession;
    game: PlaygroundGame;
    participants: SessionParticipant[];
    roundActions: TranscriptRound['actions'];
    fence: { round: number; token: string };
}): Promise<PlaygroundSession> {
    const store = await getStore();
    // This branch skips the GM resolution call but `completeSession` still buys a summary, so it
    // needs the same advisory check the resolved branch makes before its second inference call.
    if (!(await stillOwnsClaim(store, input.session.id, input.fence))) {
        return (await store.getPlaygroundSession(input.session.id))!;
    }

    const forfeitRound: TranscriptRound = {
        round: input.session.currentRound,
        gmPrompt: input.session.currentRoundPrompt || '',
        actions: input.roundActions,
        gmResolution: 'All participants forfeited. Session ended early.',
        resolvedAt: new Date().toISOString(),
    };

    const outcome = await completeSession({
        session: input.session,
        game: input.game,
        participants: input.participants,
        transcript: [...input.session.transcript, forfeitRound],
        fence: input.fence,
        memories: [],
    });
    // Ingestion is scheduled only after the CAS confirmed this resolver won. It used to run first,
    // so a resolver whose lease had lapsed still pushed vectors for a round it did not resolve —
    // the same defect the main branch closed, in the branch that skips the GM call.
    if (outcome.won) {
        schedulePlaygroundMemoryIngest(input.participants.map((p) => p.agentId), forfeitRound.gmResolution, {
            sessionId: input.session.id,
            round: input.session.currentRound,
            kind: 'playground_gm',
        });
    }
    return outcome.session;
}

/** The claimed half of tryAdvanceRound: re-read under the lease, resolve, commit fenced. */
async function resolveClaimedRound(
    sessionId: string,
    fence: { round: number; token: string }
): Promise<PlaygroundSession> {
    const store = await getStore();

    // Re-read AFTER the claim: the action set enumerated here is the one the fence protects —
    // an action that lands later is rejected by the gated insert's claim predicate, so it can no
    // longer be silently absent from the transcript inference already read.
    const session = await store.getPlaygroundSession(sessionId);
    if (!session || session.status !== 'active' || session.currentRound !== fence.round) {
        return session!;
    }
    const actions = await store.getPlaygroundActions(sessionId, fence.round);

    const { updatedParticipants, roundActions, allForfeited } = computeRoundOutcome(session, actions);

    const game = resolvePlaygroundGame(session.schoolId, session.gameId);
    if (!game) {
        throw new Error(`Game "${session.gameId}" not found for school "${session.schoolId ?? 'foundation'}"`);
    }

    if (allForfeited) {
        return completeAllForfeited({ session, game, participants: updatedParticipants, roundActions, fence });
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

    return commitResolvedRound({
        session,
        game,
        participants: updatedParticipants,
        transcript: [...session.transcript, newRound],
        newRound,
        narration: resolution.narration,
        isGameOver: resolution.isGameOver,
        fence,
    });
}

/**
 * The tail of a resolved round: settle its memories, then commit them WITH the advance, then — and
 * only then — schedule the external vector ingest that cannot join the statement.
 *
 * Split out from `resolveClaimedRound` so the paid-work guards read in one place. Every early
 * return here means "another resolver owns this round"; none of them is an error.
 */
async function commitResolvedRound(input: {
    session: PlaygroundSession;
    game: PlaygroundGame;
    participants: SessionParticipant[];
    transcript: TranscriptRound[];
    newRound: TranscriptRound;
    narration: string;
    isGameOver: boolean;
    fence: { round: number; token: string };
}): Promise<PlaygroundSession> {
    const store = await getStore();
    const { session, fence } = input;
    const reread = async () => (await store.getPlaygroundSession(session.id))!;

    // Before the embeddings, and again before the second inference call. Each is one outbound call
    // per participant, so a resolver that has already lost its lease should discover that here
    // rather than pay for the whole set. See stillOwnsClaim for why this is advisory.
    if (!(await stillOwnsClaim(store, session.id, fence))) return reread();

    // M11-1b D5 atomic follow-up: the round's memories are BUILT here (embedding is an outbound
    // call and cannot join a statement) and WRITTEN by the terminal CAS below, in the same
    // statement as the advance. So an advance and its memories now genuinely commit together —
    // the claim D5 had to withdraw when the two were separate auto-commits.
    const memories = await buildRoundMemories(session.id, input.newRound, input.participants);

    if (!(await stillOwnsClaim(store, session.id, fence))) return reread();

    const write = { ...input, memories };
    // Max rounds reached OR game returned early termination (e.g. defection outcome).
    const terminal = session.currentRound >= session.maxRounds || input.isGameOver;
    const outcome = terminal ? await completeSession(write) : await advanceToNextRound(write);

    // The CAS wrote neither the advance nor the memories, so nothing external may follow it.
    if (!outcome.won) return outcome.session;

    // External vector ingestion cannot join the transaction: an explicit best-effort residual,
    // scheduled only after the CAS confirmed this resolver won the round.
    schedulePlaygroundMemoryIngest(input.participants.map((p) => p.agentId), input.narration, {
        sessionId: session.id,
        round: session.currentRound,
        kind: 'playground_gm',
    });

    return outcome.session;
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
/**
 * `isLockLost`, threaded from `runDeadlinesAndCap`'s renewal timer: when it starts returning `true`
 * mid-sweep, the lock has already been reclaimed by a contender (a TTL this pass ran past), and
 * every phase below checks it between steps and stops claiming further work immediately — returning
 * whatever completed so far, since every phase here is independently resumable from its own
 * due-state predicate on the next sweep.
 */
async function checkDeadlines(isLockLost?: () => boolean): Promise<PlaygroundDeadlineRunResult> {
    const store = await getStore();
    let advanced = 0;
    const advanceStartedAt = performance.now();
    const lockLost = () => isLockLost?.() ?? false;

    // 1. Advance active sessions whose round has expired — **due-ASC, exhaustive, never a fixed
    // newest-first window** (u6 P3.1, replacing the `listPlaygroundSessions({status:'active',
    // limit:50})` + JS filter this used to run: with 51+ concurrent sessions the oldest overdue one
    // sat outside that window forever). `listActiveSessionsDueForRound` orders by `round_deadline`
    // ascending, so the most-overdue session is always examined first, and a successful advance moves
    // the deadline forward — which is what lets the row drop out of the next page on its own, the same
    // shrinking-predicate shape `enforceSessionLifetimeCap` uses.
    //
    // **`attemptedThisPass` is the one thing this loop needs that the lifetime cap's doesn't.** A
    // completion is nearly always successful or racily lost to a concurrent writer — either way the
    // row leaves the due set. A round advance can fail for a real reason (a broken game state, an
    // inference error) and leave `round_deadline` untouched, so re-querying "due, oldest first" without
    // tracking what this pass already tried would hand the same stuck session every page, forever
    // re-appearing at the front and starving every other due session behind it. Tracking attempted ids
    // makes a stuck session cost exactly one attempt per invocation, same as before this fix, while
    // still reaching every other due session within the pass.
    const attemptedThisPass = new Set<string>();
    for (let page = 0; page < ROUND_ADVANCE_MAX_PAGES; page += 1) {
        if (lockLost()) break;
        const due = await store.listActiveSessionsDueForRound(ROUND_ADVANCE_PAGE_SIZE);
        const fresh = due.filter((session) => !attemptedThisPass.has(session.id));
        if (fresh.length === 0) break;
        for (const session of fresh) {
            attemptedThisPass.add(session.id);
            try {
                await tryAdvanceRound(session.id);
                advanced += 1;
            } catch (err) {
                console.error(`[playground] Error advancing session ${session.id}:`, err);
            }
        }
        if (due.length < ROUND_ADVANCE_PAGE_SIZE) break;
    }
    const advanceDurationMs = performance.now() - advanceStartedAt;
    if (lockLost()) {
        console.error('[playground] Deadline lock lost mid-sweep after round advancement; stopping further claims.');
        return { advanced, capped: 0, advanceDurationMs, capDurationMs: 0 };
    }

    const capStartedAt = performance.now();
    const { completed: capped } = await enforceSessionLifetimeCap();
    const capDurationMs = performance.now() - capStartedAt;
    if (lockLost()) {
        console.error('[playground] Deadline lock lost mid-sweep after the lifetime cap; stopping further claims.');
        return { advanced, capped, advanceDurationMs, capDurationMs };
    }

    // 1b. Auto-activate pending sessions that have reached minPlayers. This is a repair path — the
    // primary path is `joinSession`'s inline activation attempt the moment a join reaches
    // `minPlayers` — so `listPendingSessionsForActivationScan`'s oldest-created-first order (u6 P3.1)
    // exists to keep a fixed window from hiding a session whose inline attempt was interrupted behind
    // a stream of freshly created pending ones, same reasoning as the round1-prompt repair below.
    try {
        const pendingToConsider = await store.listPendingSessionsForActivationScan(PENDING_ACTIVATION_SCAN_LIMIT);
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
    if (lockLost()) {
        console.error('[playground] Deadline lock lost mid-sweep after pending activation; stopping further claims.');
        return { advanced, capped, advanceDurationMs, capDurationMs };
    }

    // 1c. Repair active round-1 sessions whose prompt never landed (a crashed activation write).
    try {
        const stuck = await store.listSessionsNeedingRound1PromptRepair(ROUND1_PROMPT_REPAIR_GRACE_MS, 50);
        for (const session of stuck) {
            try {
                const game = resolvePlaygroundGame(session.schoolId, session.gameId);
                if (!game) continue;
                const roundPrompt = await generateRoundPrompt(session, game);
                const stored = await store.storeRound1PromptIfMissing(session.id, roundPrompt, ACTION_TIMEOUT_MS, [
                    playgroundRoundOpenedEvent({ sessionId: session.id, round: 1, schoolId: session.schoolId ?? null }),
                ]);
                if (stored) {
                    console.log(`[playground] Repaired missing round-1 prompt for session ${session.id}.`);
                }
            } catch (err) {
                console.error(`[playground] Error repairing round-1 prompt for session ${session.id}:`, err);
            }
        }
    } catch (err) {
        console.error('[playground] Error scanning for round-1 prompt repairs:', err);
    }
    if (lockLost()) {
        console.error('[playground] Deadline lock lost mid-sweep after round-1 prompt repair; stopping further claims.');
        return { advanced, capped, advanceDurationMs, capDurationMs };
    }

    // 1d + 1e. The rollout bridge, then create-or-re-arm — ONE pass over ONE list.
    //
    // The plan states these as two sweeps. They are fused here because they read the SAME list and
    // ask the SAME question of it — this round's `round_opened` event id — so two passes re-issue
    // both the list and the lookup for every active session on every sweep. The sweep runs against
    // the Neon HTTP driver, where each call is its own round trip, and the duplication is the whole
    // cost: it doubled the deadline sweep's wall time in the u3d integration suite, past its
    // per-test budget. Nothing about the SEQUENCE changes — the bridge still runs before the arming
    // for each session, and the two stay independently error-scoped, so a bridge failure still
    // leaves arming to run and an arming failure does not stop the next session's bridge.
    try {
        const active = await store.listPlaygroundSessions({ status: 'active', limit: 50 });
        for (const session of active) {
            // Still promptless ⇒ the repair owns this one, and the bridge must not manufacture an
            // event for a round nobody can act on. BOTH empty spellings are tested deliberately:
            // `rowToPlaygroundSession` maps a NULL column to `null` while the memory store stores
            // `undefined`, so a `=== undefined` check alone reconstructed a round_opened for every
            // promptless session in db mode — the exact ghost this kind's timing rule forbids. An
            // empty-STRING prompt is a stored prompt (the publication's `IS NULL` predicate says so)
            // and is deliberately not treated as missing here either.
            if (session.currentRoundPrompt === undefined || session.currentRoundPrompt === null) continue;

            // 1d. Rollout bridge: an active, PROMPTED current round lacking a round_opened event gets
            // exactly one synthetic one (idempotent via idem_key — a session predating this kind, or
            // one whose real event is merely slow to have landed, converges to one event either way).
            let eventId = await store.findRoundOpenedEventId(session.id, session.currentRound);
            if (!eventId) {
                try {
                    // The one UNGATED emit in this lane: the bridge has no accompanying mutation to
                    // gate on — the session is already prompted, and nothing about it is changing.
                    const emitted = await store.emitEvent(
                        playgroundRoundOpenedEvent({
                            sessionId: session.id,
                            round: session.currentRound,
                            schoolId: session.schoolId ?? null,
                            reconstructed: true,
                            idemKey: `playground_round_opened:${session.id}:${session.currentRound}`,
                        })
                    );
                    eventId = emitted.id;
                    console.log(`[playground] Reconstructed round_opened for session ${session.id} round ${session.currentRound}.`);
                } catch (err) {
                    // A 23505 on the idem key means a concurrent sweep pass already reconstructed it —
                    // benign, not an error.
                    const code = (err as { code?: string } | null)?.code;
                    if (code !== '23505') {
                        console.error(`[playground] Error reconstructing round_opened for session ${session.id}:`, err);
                    }
                    // Re-read either way: on the benign race the winner's event is what this pass
                    // must arm against, and a genuine failure simply leaves it null and skips.
                    eventId = await store.findRoundOpenedEventId(session.id, session.currentRound);
                }
            }
            if (!eventId) continue; // no round_opened for this round, so nothing to key a wakeup on

            // 1e. Create-or-re-arm wakeups for active, un-acted participants of the current round.
            try {
                // Settled before the actions read, so a session with nobody left to wake costs no
                // query at all — the common shape once participants forfeit out of a long game.
                const candidates = session.participants.filter((p) => p.status === 'active');
                if (candidates.length === 0) continue;
                const actions = await store.getPlaygroundActions(session.id, session.currentRound);
                const acted = new Set(actions.map((a) => a.agentId));
                const unActed = candidates.filter((p) => !acted.has(p.agentId));
                for (const participant of unActed) {
                    const delivery = await store.resolveWakeupDelivery(participant.agentId);
                    if (!delivery) continue;
                    // The gated variant, never the plain one (codex u5-C round 1 MAJOR): the
                    // pre-reads above are only the cheap skip — the decisive freshness check runs
                    // INSIDE this statement, FOR SHARE on the session row, so a round advancing
                    // between the read and this write arms nothing rather than arming a stale turn.
                    await store.createOrReArmPlaygroundRoundWakeup({
                        agentId: participant.agentId,
                        eventId,
                        payload: { session_id: session.id, round: session.currentRound },
                        delivery,
                        sessionId: session.id,
                        round: session.currentRound,
                    });
                }
            } catch (err) {
                console.error(`[playground] Error arming wakeups for session ${session.id}:`, err);
            }
        }
    } catch (err) {
        console.error('[playground] Error scanning active sessions for round_opened reconstruction and wakeup arming:', err);
    }
    if (lockLost()) {
        console.error('[playground] Deadline lock lost mid-sweep after wakeup arming; stopping further claims.');
        return { advanced, capped, advanceDurationMs, capDurationMs };
    }

    // 2. Expire stale pending sessions — a system TRANSITION to 'cancelled' (NULL actor +
    // sentinel reason), never a delete (M11-1 C3). The store's single conditional statement
    // carries the `status = 'pending'` predicate, so a session that activates mid-sweep is
    // untouched — the expiry-vs-activation race closes in the statement, not here.
    try {
        // ONE prepared event for the whole batch: the store fans it out, one event per expired row
        // with that row's own id as `subject_id` (the `rowSource` shape). A sweep that matched
        // nothing writes nothing and emits nothing.
        const expired = await store.expireStalePendingSessions(PENDING_TIMEOUT_MS, [
            playgroundSessionExpiredEvent(),
        ]);
        for (const id of expired) {
            console.log(`[playground] Session ${id} expired in pending state. Cancelled (system).`);
        }
    } catch (err) {
        console.error('[playground] Error expiring stale pending sessions:', err);
    }

    return { advanced, capped, advanceDurationMs, capDurationMs };
}

/**
 * The ONE export through which deadline progression runs (M11-2 u6 P3.1).
 *
 * `checkDeadlines` above is deliberately not exported — every caller that used to import it directly
 * (three playground GET routes, `agent-inbox.ts`'s inbox/context assembly — `ai/validation/
 * m11-inventory.md` §6a) now goes through `playground/lifecycle.ts`'s `runDeadlinesAndCap`, which is
 * the only file that may import this function: it holds the `worker_locks` singleton for the whole
 * call and threads its renewal-loss signal in as `isLockLost`. Importing this from anywhere else
 * would run deadline progression unlocked, defeating the lock the same way the direct
 * `checkDeadlines()` calls used to — `src/__tests__/lib/playground-deadline-lock-discipline.test.ts`
 * scans the tree for a second importer.
 */
export async function runDeadlineProgressionUnlocked(
    isLockLost?: () => boolean
): Promise<PlaygroundDeadlineRunResult> {
    return checkDeadlines(isLockLost);
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
        // Create a pending session instead of starting one immediately. The cron has no acting
        // agent, so the event's actor column is NULL — the same shape the expiry sweep takes.
        return await createPendingSession(undefined, 'foundation', [
            playgroundSessionCreatedEvent({ actorAgentId: null, schoolId: 'foundation' }),
        ]);
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
/**
 * M11-1b D5 atomic follow-up — settle each active participant's episodic memory into rows the
 * terminal CAS will write.
 *
 * This function no longer writes anything. Embedding is an outbound HTTP call and cannot join a
 * statement, so it happens here, BEFORE the resolution write; the rows it produces are then handed
 * to `applyPlaygroundResolution`, which inserts them inside its own CAS. That is what makes a
 * losing resolver write zero memories rather than "some" — the previous shape wrote one statement
 * per participant, so a mid-loop failure left the round half-remembered.
 *
 * An embedding failure is not fatal (retrieval falls back to text matching), so it degrades the row
 * rather than dropping it.
 */
async function buildRoundMemories(
    sessionId: string,
    round: TranscriptRound,
    participants: SessionParticipant[]
): Promise<ResolutionMemory[]> {
    const memories: ResolutionMemory[] = [];
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

        memories.push(
            prepareResolutionMemory({
                agentId: participant.agentId,
                agentName: participant.agentName,
                sessionId,
                content,
                embedding,
                importance,
                roundCreated: round.round,
            })
        );
    }
    return memories;
}


