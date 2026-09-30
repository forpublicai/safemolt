/**
 * Playground Memory System — durable since M11-1b D5.
 *
 * These lived in a process-local Map **even in DB mode**, so a later request served by another
 * instance, or one arriving after a cold start, saw a session's episodic memories silently
 * vanish — while the public session response advertised whether they were available. This module
 * is now a thin facade over the `playground_agent_memories` store domain (memory mode keeps a
 * map, behind `pickStore`). Semantics are unchanged: ONE record per (agent, session),
 * overwritten each round, `importance` carrying the same `low | medium | high | critical` label.
 *
 * Retrieval stays here: it is pure scoring over the rows the store returns.
 */
import { type AgentMemory, type CreateMemoryInput, type MemoryRetrievalOptions, type MemoryRetrievalResult, type ResolutionMemory } from './types';
import {
    clearPlaygroundMemoriesForAgent,
    clearPlaygroundMemoriesForSession,
    getPlaygroundMemoryForAgent,
    listPlaygroundMemoriesForSession,
    storePlaygroundMemory,
} from '@/lib/store';

let memoryIdCounter = 1;

/**
 * Generate a unique memory ID. A public entity id, not a credential — `Math.random` would be
 * fine; the counter is simply deterministic within a process (M11-1 C17's split).
 */
function generateMemoryId(): string {
    return `mem_${Date.now()}_${memoryIdCounter++}`;
}

/**
 * Store a new memory for an agent in a session (overwrites that agent's record for the session).
 */
export async function storeMemory(input: CreateMemoryInput): Promise<AgentMemory> {
    return storePlaygroundMemory({ ...input, id: generateMemoryId() });
}

/**
 * Settle a round's memory into the row the terminal CAS will write (M11-1b D5 atomic follow-up).
 *
 * The id and the timestamp are minted here rather than in the store because the store no longer
 * has a per-memory call: `applyPlaygroundResolution` writes the whole round's set as one insert
 * gated on its own CAS, so either all of a round's memories land with the advance or none do.
 */
export function prepareResolutionMemory(input: CreateMemoryInput): ResolutionMemory {
    return { ...input, id: generateMemoryId(), createdAt: new Date().toISOString() };
}

/**
 * Get the memory record for an agent in a session
 */
export async function getMemoriesForAgent(sessionId: string, agentId: string): Promise<AgentMemory | null> {
    return getPlaygroundMemoryForAgent(sessionId, agentId);
}

/**
 * Get all memories for a session (all agents)
 */
export async function getAllSessionMemories(sessionId: string): Promise<AgentMemory[]> {
    return listPlaygroundMemoriesForSession(sessionId);
}

/**
 * Calculate cosine similarity between two vectors
 */
function cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) {
        return 0;
    }
    
    let dotProduct = 0;
    let normA = 0;
    let normB = 0;
    
    for (let i = 0; i < a.length; i++) {
        dotProduct += a[i] * b[i];
        normA += a[i] * a[i];
        normB += b[i] * b[i];
    }
    
    if (normA === 0 || normB === 0) {
        return 0;
    }
    
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
}

/**
 * Simple text-based similarity (fallback when no embeddings available)
 * Uses keyword overlap and substring matching
 */
function textSimilarity(query: string, content: string): number {
    const queryLower = query.toLowerCase();
    const contentLower = content.toLowerCase();
    
    // Exact substring match
    if (contentLower.includes(queryLower)) {
        return 0.9;
    }
    
    // Word overlap
    const queryWords = queryLower.split(/\s+/).filter(w => w.length > 2);
    const contentWords = contentLower.split(/\s+/).filter(w => w.length > 2);
    
    if (queryWords.length === 0 || contentWords.length === 0) {
        return 0;
    }
    
    const overlap = queryWords.filter(w => contentWords.some(cw => cw.includes(w) || w.includes(cw))).length;
    return overlap / Math.max(queryWords.length, 1);
}

/**
 * Retrieve memories based on query
 * Uses embeddings if available, otherwise falls back to text matching
 */
export async function retrieveMemories(options: MemoryRetrievalOptions): Promise<MemoryRetrievalResult[]> {
    const { sessionId, agentId, query, queryEmbedding, limit = 5, threshold = 0.0 } = options;

    // Filter by agent if specified
    let memoryList: AgentMemory[];
    if (agentId) {
        const mem = await getPlaygroundMemoryForAgent(sessionId, agentId);
        memoryList = mem ? [mem] : [];
    } else {
        memoryList = await listPlaygroundMemoriesForSession(sessionId);
    }

    // Calculate similarity scores
    const results: MemoryRetrievalResult[] = [];
    
    for (const memory of memoryList) {
        let similarity: number;
        
        if (queryEmbedding && memory.embedding && queryEmbedding.length === memory.embedding.length) {
            // Use embedding similarity
            similarity = cosineSimilarity(queryEmbedding, memory.embedding);
        } else {
            // Fallback to text similarity
            similarity = textSimilarity(query, memory.content);
        }
        
        if (similarity >= threshold) {
            results.push({ memory, similarity });
        }
    }
    
    // Sort by similarity (highest first)
    results.sort((a, b) => b.similarity - a.similarity);
    
    // Return top results
    return results.slice(0, limit);
}

/**
 * Delete all memories for a session.
 *
 * The db FK cascades on session *deletion*, but since M11-1 C3 cancellation is a status
 * TRANSITION — nothing is deleted — so the transition drives this explicitly, in both stores
 * (M11-1b D5). This function was present but uncalled before D5.
 */
export async function clearSessionMemories(sessionId: string): Promise<void> {
    await clearPlaygroundMemoriesForSession(sessionId);
}

/**
 * Delete all memories belonging to an agent. Db mode cascades on agent deletion; memory mode has
 * no FK, so the shared agent-delete path calls this (M11-1b D5).
 */
export async function clearAgentMemories(agentId: string): Promise<void> {
    await clearPlaygroundMemoriesForAgent(agentId);
}

/**
 * Get memory importance score (for importance-based retrieval)
 */
export function getImportanceScore(importance: string): number {
    switch (importance) {
        case 'critical':
            return 1.0;
        case 'high':
            return 0.75;
        case 'medium':
            return 0.5;
        case 'low':
            return 0.25;
        default:
            return 0.5;
    }
}
