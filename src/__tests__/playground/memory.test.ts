/**
 * Tests for playground memory system
 */
import { storeMemory, retrieveMemories, getMemoriesForAgent, clearSessionMemories } from '@/lib/playground/memory';

describe('Memory System', () => {
    const testSessionId = 'test_session_memory';
    const testAgentId = 'test_agent_1';
    const testAgentName = 'TestAgent';

    beforeEach(async () => {
        // Clear memories before each test
        await clearSessionMemories(testSessionId);
    });

    afterAll(async () => {
        // Clean up
        await clearSessionMemories(testSessionId);
    });

    describe('storeMemory', () => {
        it('should store a memory and return it with an ID', async () => {
            const memory = await storeMemory({
                agentId: testAgentId,
                agentName: testAgentName,
                sessionId: testSessionId,
                content: 'This is a test memory',
                importance: 'medium',
                roundCreated: 1,
            });

            expect(memory.id).toBeDefined();
            expect(memory.agentId).toBe(testAgentId);
            expect(memory.content).toBe('This is a test memory');
            expect(memory.importance).toBe('medium');
            expect(memory.roundCreated).toBe(1);
        });

        it('should overwrite existing memory for same agent in same session', async () => {
            await storeMemory({
                agentId: testAgentId,
                agentName: testAgentName,
                sessionId: testSessionId,
                content: 'First memory',
                importance: 'low',
                roundCreated: 1,
            });

            const secondMemory = await storeMemory({
                agentId: testAgentId,
                agentName: testAgentName,
                sessionId: testSessionId,
                content: 'Second memory',
                importance: 'high',
                roundCreated: 2,
            });

            const retrieved = await getMemoriesForAgent(testSessionId, testAgentId);
            expect(retrieved?.content).toBe('Second memory');
            expect(retrieved?.importance).toBe('high');
        });
    });

    describe('getMemoriesForAgent', () => {
        it('should return null for non-existent agent', async () => {
            const memory = await getMemoriesForAgent(testSessionId, 'non_existent_agent');
            expect(memory).toBeNull();
        });

        it('should return stored memory for agent', async () => {
            await storeMemory({
                agentId: testAgentId,
                agentName: testAgentName,
                sessionId: testSessionId,
                content: 'Test content',
                importance: 'high',
                roundCreated: 1,
            });

            const memory = await getMemoriesForAgent(testSessionId, testAgentId);
            expect(memory).not.toBeNull();
            expect(memory?.content).toBe('Test content');
        });
    });

    describe('retrieveMemories', () => {
        it('should return empty array for non-existent session', async () => {
            const results = await retrieveMemories({
                sessionId: 'non_existent_session',
                query: 'test',
            });
            expect(results).toEqual([]);
        });

        it('should use text similarity when no embeddings available', async () => {
            await storeMemory({
                agentId: testAgentId,
                agentName: testAgentName,
                sessionId: testSessionId,
                content: 'The agent made a trade deal',
                importance: 'medium',
                roundCreated: 1,
            });

            const results = await retrieveMemories({
                sessionId: testSessionId,
                query: 'trade',
                threshold: 0.5,
            });

            expect(results.length).toBeGreaterThan(0);
            expect(results[0].memory.content).toContain('trade');
        });

        it('should respect limit parameter', async () => {
            // Store multiple memories
            await storeMemory({
                agentId: testAgentId,
                agentName: testAgentName,
                sessionId: testSessionId,
                content: 'Memory 1 about trading',
                importance: 'medium',
                roundCreated: 1,
            });

            await storeMemory({
                agentId: testAgentId,
                agentName: testAgentName,
                sessionId: testSessionId,
                content: 'Memory 2 about fighting',
                importance: 'medium',
                roundCreated: 2,
            });

            const results = await retrieveMemories({
                sessionId: testSessionId,
                query: 'memory',
                limit: 1,
            });

            expect(results.length).toBe(1);
        });
    });

    describe('clearSessionMemories', () => {
        it('should clear all memories for a session', async () => {
            await storeMemory({
                agentId: testAgentId,
                agentName: testAgentName,
                sessionId: testSessionId,
                content: 'Test memory',
                importance: 'medium',
                roundCreated: 1,
            });

            await clearSessionMemories(testSessionId);

            const memory = await getMemoriesForAgent(testSessionId, testAgentId);
            expect(memory).toBeNull();
        });
    });
});
