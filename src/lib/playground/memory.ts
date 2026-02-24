/**
 * Playground Memory System
 * In-memory store for agent memories in playground sessions.
 * Uses globalThis to persist data across Next.js HMR.
 */
import { type AgentMemory, type CreateMemoryInput, type MemoryRetrievalOptions, type MemoryRetrievalResult } from './types';

// Global storage for memories - keyed by sessionId, then agentId
const globalMemories = globalThis as typeof globalThis & {
    __playground_memories?: Map<string, Map<string, AgentMemory>>; // sessionId -> agentId -> memory
};

const memories = globalMemories.__playground_memories ??= new Map<string, Map<string, AgentMemory>>();

let memoryIdCounter = 1;

/**
 * Generate a unique memory ID
 */
function generateMemoryId(): string {
    return `mem_${Date.now()}_${memoryIdCounter++}`;
}

/**
 * Store a new memory for an agent in a session
 */
export async function storeMemory(input: CreateMemoryInput): Promise<AgentMemory> {
    const { agentId, agentName, sessionId, content, embedding, importance, roundCreated } = input;
    
    const memory: AgentMemory = {
        id: generateMemoryId(),
        agentId,
        agentName,
        sessionId,
        content,
        embedding,
        importance,
        roundCreated,
        createdAt: new Date().toISOString(),
    };
    
    // Get or create session's memory map
    if (!memories.has(sessionId)) {
        memories.set(sessionId, new Map());
    }
    const sessionMemories = memories.get(sessionId)!;
    
    // Store memory
    sessionMemories.set(agentId, memory);
    
    return memory;
}

/**
 * Get all memories for an agent in a session
 */
export async function getMemoriesForAgent(sessionId: string, agentId: string): Promise<AgentMemory | null> {
    const sessionMemories = memories.get(sessionId);
    if (!sessionMemories) {
        return null;
    }
    return sessionMemories.get(agentId) ?? null;
}

/**
 * Get all memories for a session (all agents)
 */
export async function getAllSessionMemories(sessionId: string): Promise<AgentMemory[]> {
    const sessionMemories = memories.get(sessionId);
    if (!sessionMemories) {
        return [];
    }
    return Array.from(sessionMemories.values());
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
    
    const sessionMemories = memories.get(sessionId);
    if (!sessionMemories) {
        return [];
    }
    
    // Filter by agent if specified
    let memoryList: AgentMemory[];
    if (agentId) {
        const mem = sessionMemories.get(agentId);
        memoryList = mem ? [mem] : [];
    } else {
        memoryList = Array.from(sessionMemories.values());
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
 * Delete all memories for a session
 */
export async function clearSessionMemories(sessionId: string): Promise<void> {
    memories.delete(sessionId);
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
