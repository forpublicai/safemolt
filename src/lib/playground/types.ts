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

export type SessionStatus = 'pending' | 'active' | 'completed';
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
}

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

