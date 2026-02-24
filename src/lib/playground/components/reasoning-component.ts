/**
 * Reasoning Component
 * Tracks agent reasoning and decision-making processes.
 */
import type { Component, ComponentState, ComponentType } from '../types';

const REASONING_COMPONENT_ID = 'reasoning';
const REASONING_COMPONENT_NAME = 'Reasoning Chain';

// In-memory storage for reasoning chains
type ReasoningEntry = { thought: string; timestamp: string };
const reasoningChains = new Map<string, ReasoningEntry[]>();

/**
 * Reasoning component for tracking agent thought processes
 */
export const reasoningComponent: Component = {
    id: REASONING_COMPONENT_ID,
    name: REASONING_COMPONENT_NAME,
    type: 'reasoning' as ComponentType,

    async initialize(agentId: string, sessionId: string): Promise<void> {
        const key = `${sessionId}:${agentId}`;
        if (!reasoningChains.has(key)) {
            reasoningChains.set(key, []);
        }
        console.log(`[ReasoningComponent] Initialized for agent ${agentId} in session ${sessionId}`);
    },

    async update(agentId: string, sessionId: string, roundData: Record<string, unknown>): Promise<void> {
        const { round, thought, reasoning } = roundData;
        
        if (!round) {
            return;
        }

        const key = `${sessionId}:${agentId}`;
        const chain = reasoningChains.get(key);
        
        if (!chain) {
            return;
        }

        const thoughtText = String(thought || reasoning || 'No reasoning provided');
        
        chain.push({
            thought: `Round ${round}: ${thoughtText}`,
            timestamp: new Date().toISOString(),
        });

        // Keep only last 20 thoughts
        if (chain.length > 20) {
            chain.shift();
        }
    },

    async getState(agentId: string, sessionId: string): Promise<ComponentState> {
        const key = `${sessionId}:${agentId}`;
        const chain = reasoningChains.get(key);
        
        return {
            hasThoughts: !!chain && chain.length > 0,
            thoughtCount: chain?.length || 0,
        };
    },

    async getPromptContext(agentId: string, sessionId: string): Promise<string> {
        const key = `${sessionId}:${agentId}`;
        const chain = reasoningChains.get(key);
        
        if (!chain || chain.length === 0) {
            return '';
        }

        // Return last 3 thoughts
        const recentThoughts = chain.slice(-3);
        const thoughtsText = recentThoughts.map(t => t.thought).join('\n');

        return `\n\nRECENT REASONING:\n${thoughtsText}`;
    },
};

/**
 * Get full reasoning chain for an agent
 */
export function getReasoningChain(sessionId: string, agentId: string): { thought: string; timestamp: string }[] {
    const key = `${sessionId}:${agentId}`;
    return reasoningChains.get(key) || [];
}

/**
 * Clear reasoning chain for a session
 */
export function clearReasoningChain(sessionId: string): void {
    const keysToDelete: string[] = [];
    reasoningChains.forEach((_, key) => {
        if (key.startsWith(`${sessionId}:`)) {
            keysToDelete.push(key);
        }
    });
    keysToDelete.forEach(key => reasoningChains.delete(key));
}

export default reasoningComponent;
