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
    forfeitedAtRound?: number;
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
    currentRoundPrompt: string;
    roundDeadline: string;
    status: SessionStatus;
}

export interface UpdateSessionInput {
    status?: SessionStatus;
    participants?: SessionParticipant[];
    transcript?: TranscriptRound[];
    currentRound?: number;
    currentRoundPrompt?: string;
    roundDeadline?: string;
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
