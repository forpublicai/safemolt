/**
 * Tests for playground world state
 */
import {
    initializeWorldState,
    getWorldState,
    clearWorldState,
    getRelationships,
    setRelationship,
    addInventoryItem,
    getInventory,
    addLocation,
    getLocations,
    moveAgent,
    addWorldEvent,
    getRecentEvents,
} from '@/lib/playground/world-state';

describe('World State', () => {
    const testSessionId = 'test_session_world';

    beforeEach(() => {
        // Initialize world state before each test
        initializeWorldState(testSessionId);
    });

    afterEach(() => {
        // Clean up
        clearWorldState(testSessionId);
    });

    describe('initializeWorldState', () => {
        it('should initialize an empty world state', () => {
            const state = getWorldState(testSessionId);
            expect(state).toBeDefined();
            expect(state?.sessionId).toBe(testSessionId);
            expect(state?.relationships).toEqual([]);
            expect(state?.locations).toEqual([]);
            expect(state?.events).toEqual([]);
        });
    });

    describe('Relationships', () => {
        it('should get empty relationships initially', () => {
            const relationships = getRelationships(testSessionId);
            expect(relationships).toEqual([]);
        });

        it('should set and get relationships', () => {
            setRelationship(testSessionId, {
                agentId: 'agent_1',
                otherAgentId: 'agent_2',
                type: 'ally',
                strength: 75,
                history: ['Formed alliance in round 1'],
            });

            const relationships = getRelationships(testSessionId, 'agent_1');
            expect(relationships.length).toBe(1);
            expect(relationships[0].type).toBe('ally');
            expect(relationships[0].strength).toBe(75);
        });

        it('should filter relationships by agent', () => {
            setRelationship(testSessionId, {
                agentId: 'agent_1',
                otherAgentId: 'agent_2',
                type: 'ally',
                strength: 50,
                history: [],
            });

            setRelationship(testSessionId, {
                agentId: 'agent_3',
                otherAgentId: 'agent_4',
                type: 'enemy',
                strength: -80,
                history: [],
            });

            const agent1Relationships = getRelationships(testSessionId, 'agent_1');
            expect(agent1Relationships.length).toBe(1);
            expect(agent1Relationships[0].agentId).toBe('agent_1');
        });
    });

    describe('Inventory', () => {
        it('should add items to inventory', () => {
            addInventoryItem(testSessionId, 'agent_1', { resource: 'gold', quantity: 10 });
            addInventoryItem(testSessionId, 'agent_1', { resource: 'silver', quantity: 5 });

            const inventory = getInventory(testSessionId, 'agent_1');
            expect(inventory.length).toBe(2);
            expect(inventory.find(i => i.resource === 'gold')?.quantity).toBe(10);
        });

        it('should accumulate quantity for same resource', () => {
            addInventoryItem(testSessionId, 'agent_1', { resource: 'gold', quantity: 10 });
            addInventoryItem(testSessionId, 'agent_1', { resource: 'gold', quantity: 5 });

            const inventory = getInventory(testSessionId, 'agent_1');
            expect(inventory.length).toBe(1);
            expect(inventory[0].quantity).toBe(15);
        });

        it('should return empty array for non-existent agent', () => {
            const inventory = getInventory(testSessionId, 'non_existent');
            expect(inventory).toEqual([]);
        });
    });

    describe('Locations', () => {
        it('should add locations', () => {
            addLocation(testSessionId, {
                name: 'Town Square',
                description: 'A bustling marketplace',
                occupants: [],
                exits: ['Tavern', 'Blacksmith'],
                items: [],
            });

            const locations = getLocations(testSessionId);
            expect(locations.length).toBe(1);
            expect(locations[0].name).toBe('Town Square');
        });

        it('should move agents between locations', () => {
            addLocation(testSessionId, {
                name: 'Tavern',
                description: 'A cozy tavern',
                occupants: [],
                exits: ['Town Square'],
                items: [],
            });

            addLocation(testSessionId, {
                name: 'Town Square',
                description: 'A bustling marketplace',
                occupants: [],
                exits: ['Tavern'],
                items: [],
            });

            moveAgent(testSessionId, 'agent_1', 'Tavern');

            const tavern = getLocations(testSessionId).find(l => l.name === 'Tavern');
            expect(tavern?.occupants).toContain('agent_1');
        });
    });

    describe('Events', () => {
        it('should add and retrieve world events', () => {
            addWorldEvent(testSessionId, {
                type: 'trade',
                description: 'Agent 1 traded with Agent 2',
                participants: ['agent_1', 'agent_2'],
                round: 1,
                timestamp: new Date().toISOString(),
            });

            const events = getRecentEvents(testSessionId);
            expect(events.length).toBe(1);
            expect(events[0].type).toBe('trade');
        });

        it('should limit events to last 10 by default', () => {
            for (let i = 0; i < 15; i++) {
                addWorldEvent(testSessionId, {
                    type: 'movement',
                    description: `Event ${i}`,
                    participants: ['agent_1'],
                    round: i,
                    timestamp: new Date().toISOString(),
                });
            }

            const events = getRecentEvents(testSessionId);
            expect(events.length).toBe(10);
        });

        it('should respect custom limit', () => {
            for (let i = 0; i < 5; i++) {
                addWorldEvent(testSessionId, {
                    type: 'movement',
                    description: `Event ${i}`,
                    participants: ['agent_1'],
                    round: i,
                    timestamp: new Date().toISOString(),
                });
            }

            const events = getRecentEvents(testSessionId, 3);
            expect(events.length).toBe(3);
        });
    });
});
