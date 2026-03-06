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
export type ParticipantStatus = 'active' | 'forfeited';

/** A participant in a playground session */
export interface SessionParticipant {
    agentId: string;
    agentName: string;
    status: ParticipantStatus;
    prefabId?: string;      // Agent's personality template (optional)
    forfeitedAtRound?: number;
    missedRounds?: number;  // Consecutive missed rounds (forfeit after 2)
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
    status: SessionStatus;
    participants: SessionParticipant[];
    transcript: TranscriptRound[];
    currentRound: number;
    currentRoundPrompt?: string;    // Current GM prompt awaiting agent actions
    roundDeadline?: string;         // ISO timestamp — when the current round expires
    maxRounds: number;
    summary?: string;               // GM-generated summary at end
    memories?: AgentMemory[];        // Session memories for all agents
    worldState?: WorldState;         // Current world state
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

// ============================================
// World State (Concordia)
// ============================================

/** A relationship between two agents */
export interface Relationship {
    agentId: string;
    otherAgentId: string;
    type: 'ally' | 'enemy' | 'neutral' | 'trusted' | 'suspicious';
    strength: number;  // -100 to 100
    history: string[];  // Brief history notes
}

/** An item in an agent's inventory */
export interface InventoryItem {
    resource: string;
    quantity: number;
}

/** A location in the game world */
export interface Location {
    name: string;
    description: string;
    occupants: string[];  // Agent IDs
    exits: string[];  // Other location names
    items: InventoryItem[];
}

/** A significant event that happened in the world */
export interface WorldEvent {
    type: 'trade' | 'conflict' | 'discovery' | 'betrayal' | 'alliance' | 'movement';
    description: string;
    participants: string[];  // Agent IDs involved
    round: number;
    timestamp: string;
}

/** The complete world state for a session */
export interface WorldState {
    sessionId: string;
    relationships: Relationship[];
    inventories: Map<string, InventoryItem[]>;  // agentId -> items
    locations: Location[];
    events: WorldEvent[];
}

// ============================================
// Component System (Concordia)
// ============================================

/** Types of components that can be attached to an agent */
export type ComponentType = 'memory' | 'reasoning' | 'perception' | 'action';

/** Component state that can be serialized */
export interface ComponentState {
    [key: string]: unknown;
}

/** Base interface for all components */
export interface Component {
    id: string;
    name: string;
    type: ComponentType;

    /** Initialize the component for an agent in a session */
    initialize(agentId: string, sessionId: string, context?: Record<string, unknown>): Promise<void>;

    /** Update component state after each round */
    update(agentId: string, sessionId: string, roundData: Record<string, unknown>): Promise<void>;

    /** Get current component state */
    getState(agentId: string, sessionId: string): Promise<ComponentState>;

    /** Get context for prompt generation */
    getPromptContext(agentId: string, sessionId: string): Promise<string>;
}

/** A registered component in the system */
export interface RegisteredComponent {
    component: Component;
    enabled: boolean;
    config?: Record<string, unknown>;
}

/** Component registry for the session */
export interface ComponentRegistry {
    [componentId: string]: RegisteredComponent;
}
