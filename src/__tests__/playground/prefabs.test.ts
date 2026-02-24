/**
 * Tests for playground agent prefabs
 */
import { getPrefab, listPrefabs, getDefaultPrefab, getRandomPrefab, prefabExists } from '@/lib/playground/prefabs';

describe('Agent Prefabs', () => {
    describe('listPrefabs', () => {
        it('should return list of prefabs', () => {
            const prefabs = listPrefabs();
            expect(prefabs.length).toBeGreaterThan(0);
        });

        it('should have required properties on each prefab', () => {
            const prefabs = listPrefabs();
            for (const prefab of prefabs) {
                expect(prefab.id).toBeDefined();
                expect(prefab.name).toBeDefined();
                expect(prefab.description).toBeDefined();
                expect(prefab.traits).toBeDefined();
                expect(prefab.memoryStrategy).toBeDefined();
                expect(prefab.promptTemplate).toBeDefined();
            }
        });
    });

    describe('getPrefab', () => {
        it('should return prefab by ID', () => {
            const prefab = getPrefab('the_diplomat');
            expect(prefab).toBeDefined();
            expect(prefab?.name).toBe('The Diplomat');
        });

        it('should return undefined for non-existent prefab', () => {
            const prefab = getPrefab('non_existent');
            expect(prefab).toBeUndefined();
        });
    });

    describe('prefabExists', () => {
        it('should return true for existing prefab', () => {
            expect(prefabExists('the_diplomat')).toBe(true);
            expect(prefabExists('the_strategist')).toBe(true);
            expect(prefabExists('the_enigma')).toBe(true);
        });

        it('should return false for non-existent prefab', () => {
            expect(prefabExists('non_existent')).toBe(false);
        });
    });

    describe('getDefaultPrefab', () => {
        it('should return The Diplomat as default', () => {
            const defaultPrefab = getDefaultPrefab();
            expect(defaultPrefab.id).toBe('the_diplomat');
        });
    });

    describe('getRandomPrefab', () => {
        it('should return a valid prefab', () => {
            const randomPrefab = getRandomPrefab();
            expect(randomPrefab).toBeDefined();
            expect(listPrefabs().some(p => p.id === randomPrefab.id)).toBe(true);
        });
    });

    describe('Prefab Traits', () => {
        it('should have valid trait ranges (0-100)', () => {
            const prefabs = listPrefabs();
            for (const prefab of prefabs) {
                expect(prefab.traits.openness).toBeGreaterThanOrEqual(0);
                expect(prefab.traits.openness).toBeLessThanOrEqual(100);
                expect(prefab.traits.conscientiousness).toBeGreaterThanOrEqual(0);
                expect(prefab.traits.conscientiousness).toBeLessThanOrEqual(100);
                expect(prefab.traits.extraversion).toBeGreaterThanOrEqual(0);
                expect(prefab.traits.extraversion).toBeLessThanOrEqual(100);
                expect(prefab.traits.agreeableness).toBeGreaterThanOrEqual(0);
                expect(prefab.traits.agreeableness).toBeLessThanOrEqual(100);
                expect(prefab.traits.neuroticism).toBeGreaterThanOrEqual(0);
                expect(prefab.traits.neuroticism).toBeLessThanOrEqual(100);
            }
        });

        it('should have memory strategies defined', () => {
            const prefabs = listPrefabs();
            for (const prefab of prefabs) {
                expect(typeof prefab.memoryStrategy.relationshipFocus).toBe('boolean');
                expect(typeof prefab.memoryStrategy.planFocus).toBe('boolean');
                expect(typeof prefab.memoryStrategy.observationFocus).toBe('boolean');
            }
        });
    });
});
