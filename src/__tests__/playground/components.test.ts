/**
 * Tests for playground components
 */
import { memoryComponent, reasoningComponent } from '@/lib/playground/components';
import { getAllComponents, getComponentById, createDefaultRegistry } from '@/lib/playground/components';

describe('Components', () => {
    const testSessionId = 'test_session_components';
    const testAgentId = 'test_agent_components';

    describe('Component Registry', () => {
        it('should get all components', () => {
            const components = getAllComponents();
            expect(components.length).toBeGreaterThan(0);
        });

        it('should get component by ID', () => {
            const memory = getComponentById('memory');
            expect(memory).toBeDefined();
            expect(memory?.id).toBe('memory');

            const reasoning = getComponentById('reasoning');
            expect(reasoning).toBeDefined();
            expect(reasoning?.id).toBe('reasoning');
        });

        it('should return undefined for non-existent component', () => {
            const component = getComponentById('non_existent');
            expect(component).toBeUndefined();
        });

        it('should create default registry with all components enabled', () => {
            const registry = createDefaultRegistry();
            expect(Object.keys(registry).length).toBeGreaterThan(0);
            expect(registry['memory']).toBeDefined();
            expect(registry['memory'].enabled).toBe(true);
            expect(registry['reasoning']).toBeDefined();
            expect(registry['reasoning'].enabled).toBe(true);
        });
    });

    describe('Memory Component', () => {
        it('should have correct type and name', () => {
            expect(memoryComponent.id).toBe('memory');
            expect(memoryComponent.name).toBe('Episodic Memory');
            expect(memoryComponent.type).toBe('memory');
        });

        it('should initialize without errors', async () => {
            await expect(
                memoryComponent.initialize(testAgentId, testSessionId)
            ).resolves.not.toThrow();
        });

        it('should get state', async () => {
            await memoryComponent.initialize(testAgentId, testSessionId);
            const state = await memoryComponent.getState(testAgentId, testSessionId);
            expect(state).toBeDefined();
            expect(state.hasMemory).toBe(false);
        });
    });

    describe('Reasoning Component', () => {
        it('should have correct type and name', () => {
            expect(reasoningComponent.id).toBe('reasoning');
            expect(reasoningComponent.name).toBe('Reasoning Chain');
            expect(reasoningComponent.type).toBe('reasoning');
        });

        it('should initialize without errors', async () => {
            await expect(
                reasoningComponent.initialize(testAgentId, testSessionId)
            ).resolves.not.toThrow();
        });

        it('should update with round data', async () => {
            await reasoningComponent.initialize(testAgentId, testSessionId);
            await reasoningComponent.update(testAgentId, testSessionId, {
                round: 1,
                thought: 'I should form an alliance',
            });

            const state = await reasoningComponent.getState(testAgentId, testSessionId);
            expect(state.hasThoughts).toBe(true);
            expect(state.thoughtCount).toBe(1);
        });

        it('should get prompt context', async () => {
            await reasoningComponent.initialize(testAgentId, testSessionId);
            await reasoningComponent.update(testAgentId, testSessionId, {
                round: 1,
                thought: 'Test thought',
            });

            const context = await reasoningComponent.getPromptContext(testAgentId, testSessionId);
            expect(context).toContain('Test thought');
        });
    });

    describe('Component Interface', () => {
        it('all components should have required methods', () => {
            const components = getAllComponents();
            for (const component of components) {
                expect(typeof component.initialize).toBe('function');
                expect(typeof component.update).toBe('function');
                expect(typeof component.getState).toBe('function');
                expect(typeof component.getPromptContext).toBe('function');
            }
        });

        it('all components should have valid types', () => {
            const components = getAllComponents();
            const validTypes = ['memory', 'reasoning', 'perception', 'action'];
            for (const component of components) {
                expect(validTypes).toContain(component.type);
            }
        });
    });
});
