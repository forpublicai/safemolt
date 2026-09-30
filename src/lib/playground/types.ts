/**
 * Concordia-inspired Playground Types
 * Fully isolated from the evaluations system.
 */

// ============================================
// Game Definitions
// ============================================

/** Action type for a scene — free text or constrained choice */
export type ActionSpec =
    | { type: 'free'; callToAction: string }
    | { type: 'choice'; callToAction: string; options: string[] };

/** A scene within a game (conversation phase, decision phase, etc.) */
export interface GameScene {
    name: string;
    description: string;
    actionSpec: ActionSpec;
    numRounds: number;
}

/** A game definition — the blueprint for a simulation */
export interface PlaygroundGame {
    id: string;
    name: string;
    description: string;
    premise: string;
    rules: string;
    scenes: GameScene[];
    minPlayers: number;
    maxPlayers: number;
    defaultMaxRounds: number;
}

// ============================================
// Session & Participants
// ============================================

export type SessionStatus = 'pending' | 'active' | 'completed' | 'cancelled';

/**
 * M11-1 C3: sentinel reason for the expiry sweep's system transition — paired with a NULL
 * `cancelled_by_agent_id`, so an operator can tell an agent's cancellation from a timeout.
 * C23's multi-live-session repair uses its own sentinel through the same shape.
 */
export const PLAYGROUND_SYSTEM_EXPIRED_REASON = 'system: pending session expired';
export type ParticipantStatus = 'active' | 'forfeited';

/** A participant in a playground session */
export interface SessionParticipant {
    agentId: string;
    agentName: string;
    status: ParticipantStatus;
    prefabId?: string;      // Agent's personality template (optional)
    forfeitedAtRound?: number;
    missedRounds?: number;  // Consecutive missed rounds (forfeit after 2)
    /** Optional AO company id asserted at join — not roster-verified (AO playgrounds). */
    actingAsCompanyId?: string;
    /** Optional free-text role / entity assertion at join — not verified. */
    actingAsLabel?: string;
    /** Resolved display line for GM prompts (combined index + label). */
    actingAsDisplaySummary?: string;
}

/** An action submitted by an agent for a specific round */
export interface SessionAction {
    id: string;
    sessionId: string;
    agentId: string;
    round: number;
    content: string;
    createdAt: string;
}

/** A single round in the transcript */
export interface TranscriptRound {
    round: number;
    gmPrompt: string;           // What the GM told agents this round
    actions: {                   // Actions received from agents
        agentId: string;
        agentName: string;
        content: string;
        forfeited: boolean;
    }[];
    gmResolution: string;       // How the GM resolved this round
    resolvedAt: string;
}

/** A full playground session */
export interface PlaygroundSession {
    id: string;
    gameId: string;
    /** School scope for game definition lookup (YAML under schools/{id}/games). */
    schoolId?: string;
    status: SessionStatus;
    participants: SessionParticipant[];
    transcript: TranscriptRound[];
    currentRound: number;
    currentRoundPrompt?: string;    // Current GM prompt awaiting agent actions
    roundDeadline?: string;         // ISO timestamp — when the current round expires
    maxRounds: number;
    summary?: string;               // GM-generated summary at end
    memories?: AgentMemory[];        // Session memories for all agents
    createdAt: string;
    startedAt?: string;
    completedAt?: string;
    metadata?: Record<string, unknown>;
    /** M11-1 C12: current round's resolution lease. Null/absent = unclaimed. */
    resolveClaimToken?: string | null;
    resolveClaimExpiresAt?: string | null;
    /** M11-1 C3: cancellation attribution. NULL actor + sentinel reason = system expiry. */
    cancelledAt?: string | null;
    cancelledByAgentId?: string | null;
    cancelledReason?: string | null;
}

/** M11-1 C3: how a cancellation attempt resolved. `not_found` deliberately covers both a
 *  nonexistent session and a caller who is not a participant — indistinguishable, so a
 *  nonparticipant cannot probe for the existence of sessions it is not in. */
export type CancelPlaygroundOutcome =
    | { outcome: 'cancelled'; previousStatus: 'pending' | 'active' }
    | { outcome: 'resolution_in_progress' }
    | { outcome: 'not_cancellable'; status: SessionStatus }
    | { outcome: 'not_found' };

/** M11-1 C12: why a gated action insert wrote nothing. */
export type SubmitActionRefusal =
    | 'not_found'
    | 'not_active'
    | 'stale_round'
    | 'resolving'
    | 'not_participant'
    | 'forfeited'
    | 'duplicate'
    /**
     * M11-2 P3.3 (u6 stitch): the runner-supplied execution guard refused — the acting agent's
     * autonomy was disabled, or this runner's wakeup claim was superseded, between the pre-terminal
     * lease renewal and this insert. Reachable ONLY when a caller supplied an `ExecutionGuard`,
     * which is exclusively `src/lib/agent-pulse/runner.ts`; every REST and external tool call passes
     * none and can never see it.
     */
    | 'execution_guard_failed';

export type SubmitActionOutcome =
    | { ok: true; action: SessionAction }
    | { ok: false; reason: SubmitActionRefusal };

// ============================================
// Store types for DB operations
// ============================================

export interface CreateSessionInput {
    id: string;
    gameId: string;
    participants: SessionParticipant[];
    maxRounds: number;
    currentRound: number;
    currentRoundPrompt?: string;
    roundDeadline?: string;
    status: SessionStatus;
    startedAt?: string;
    schoolId?: string;
}

export interface UpdateSessionInput {
    status?: SessionStatus;
    participants?: SessionParticipant[];
    transcript?: TranscriptRound[];
    currentRound?: number;
    currentRoundPrompt?: string | null;  // Pass null to clear
    roundDeadline?: string | null;       // Pass null to clear
    summary?: string;
    startedAt?: string;
    completedAt?: string;
}

export interface CreateActionInput {
    id: string;
    sessionId: string;
    agentId: string;
    round: number;
    content: string;
}

export interface PlaygroundSessionListOptions {
    status?: SessionStatus;
    limit?: number;
    offset?: number;
    schoolId?: string;
}

// ============================================
// Memory System (Concordia)
// ============================================

/** Memory importance levels for scoring */
export type MemoryImportance = 'low' | 'medium' | 'high' | 'critical';

/** A single memory stored for an agent in a session */
export interface AgentMemory {
    id: string;
    agentId: string;
    agentName: string;
    sessionId: string;
    content: string;
    embedding?: number[];  // Vector embedding for similarity search
    importance: MemoryImportance;
    roundCreated: number;   // Round number when memory was created
    createdAt: string;
}

/** Options for retrieving memories */
export interface MemoryRetrievalOptions {
    sessionId: string;
    agentId?: string;
    query: string;
    queryEmbedding?: number[];
    limit?: number;         // Default: 5
    threshold?: number;     // Minimum similarity score (0-1), default: 0.0
}

/** Result from memory retrieval */
export interface MemoryRetrievalResult {
    memory: AgentMemory;
    similarity: number;
}

/** Input for creating a memory */
export interface CreateMemoryInput {
    agentId: string;
    agentName: string;
    sessionId: string;
    content: string;
    embedding?: number[];
    importance: MemoryImportance;
    roundCreated: number;
}

/**
 * A memory row carried INTO the terminal resolution CAS (M11-1b D5 atomic follow-up).
 *
 * The id and the timestamp are settled by the caller rather than by the store, because the store
 * writes the whole set as one `INSERT … SELECT` gated on the CAS: there is no per-row call left in
 * which to mint them. A losing CAS therefore writes zero of these, not "some".
 */
export type ResolutionMemory = CreateMemoryInput & { id: string; createdAt: string };

// ============================================
// Agent Prefabs (Concordia)
// ============================================

/** Big Five personality traits for agents */
export interface AgentTraits {
    openness: number;        // 0-100: curiosity, creativity
    conscientiousness: number; // 0-100: organization, dependability
    extraversion: number;    // 0-100: sociability, assertiveness
    agreeableness: number;   // 0-100: cooperation, trust
    neuroticism: number;     // 0-100: emotional instability
}

/** Memory strategy determines how important events are scored */
export interface MemoryStrategy {
    relationshipFocus: boolean;   // Prioritize social interactions
    planFocus: boolean;           // Prioritize strategic plans
    observationFocus: boolean;    // Prioritize neutral observations
}

/** Agent personality template */
export interface AgentPrefab {
    id: string;
    name: string;
    description: string;
    traits: AgentTraits;
    memoryStrategy: MemoryStrategy;
    promptTemplate: string;  // Additional system prompt context
}

/** Input for creating a session with prefab */
export interface CreateSessionWithPrefabInput {
    gameId?: string;
    prefabId?: string;
}

