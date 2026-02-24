/**
 * Memory Component
 * Handles episodic memory storage and retrieval for agents.
 */
import type { Component, ComponentState, ComponentType } from '../types';
import { storeMemory, getMemoriesForAgent, retrieveMemories, getAllSessionMemories } from '../memory';
import { getEmbedding } from '../embeddings';
import type { MemoryImportance } from '../types';

const MEMORY_COMPONENT_ID = 'memory';
const MEMORY_COMPONENT_NAME = 'Episodic Memory';

/**
 * Memory component for storing and retrieving agent memories
 */
export const memoryComponent: Component = {
    id: MEMORY_COMPONENT_ID,
    name: MEMORY_COMPONENT_NAME,
    type: 'memory' as ComponentType,

    async initialize(agentId: string, sessionId: string): Promise<void> {
        // No initialization needed - memories are stored per-session
        console.log(`[MemoryComponent] Initialized for agent ${agentId} in session ${sessionId}`);
    },

    async update(agentId: string, sessionId: string, roundData: Record<string, unknown>): Promise<void> {
        const { round, gmResolution, action, agentName } = roundData;
        
        if (!round || !gmResolution) {
            return;
        }

        // Determine importance based on round data
        let importance: MemoryImportance = 'low';
        
        if (roundData.significant === true) {
            importance = 'high';
        } else if (roundData.actionTaken === true) {
            importance = 'medium';
        }

        // Generate memory content
        const content = `Round ${round}: ${action ? `I did "${action}"` : 'No action'}. GM noted: ${String(gmResolution).slice(0, 200)}`;

        // Try to get embedding
        let embedding;
        try {
            embedding = await getEmbedding(content);
        } catch {
            console.log(`[MemoryComponent] Embedding unavailable, using text-only storage`);
        }

        // Store the memory
        await storeMemory({
            agentId,
            agentName: String(agentName || agentId),
            sessionId,
            content,
            embedding,
            importance,
            roundCreated: Number(round),
        });
    },

    async getState(agentId: string, sessionId: string): Promise<ComponentState> {
        const memory = await getMemoriesForAgent(sessionId, agentId);
        
        return {
            hasMemory: !!memory,
            lastRound: memory?.roundCreated,
            importance: memory?.importance,
        };
    },

    async getPromptContext(agentId: string, sessionId: string): Promise<string> {
        const memory = await getMemoriesForAgent(sessionId, agentId);
        
        if (!memory) {
            return '';
        }

        return `\n\nMEMORY: ${memory.content} (importance: ${memory.importance})`;
    },
};

export default memoryComponent;
