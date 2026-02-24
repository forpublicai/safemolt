/**
 * World State Management
 * Query and update the world state for a playground session.
 */
import type { WorldState, Relationship, InventoryItem, Location, WorldEvent } from './types';

// ============================================
// In-memory storage for world states
// ============================================

const worldStates = new Map<string, WorldState>();

// ============================================
// Initialization
// ============================================

/**
 * Initialize world state for a new session
 */
export function initializeWorldState(sessionId: string): WorldState {
    const state: WorldState = {
        sessionId,
        relationships: [],
        inventories: new Map(),
        locations: [],
        events: [],
    };
    worldStates.set(sessionId, state);
    return state;
}

/**
 * Get world state for a session
 */
export function getWorldState(sessionId: string): WorldState | undefined {
    return worldStates.get(sessionId);
}

/**
 * Clear world state for a session
 */
export function clearWorldState(sessionId: string): void {
    worldStates.delete(sessionId);
}

// ============================================
// Relationship queries
// ============================================

/**
 * Get all relationships for an agent
 */
export function getRelationships(sessionId: string, agentId?: string): Relationship[] {
    const state = worldStates.get(sessionId);
    if (!state) return [];
    
    if (agentId) {
        return state.relationships.filter(r => r.agentId === agentId || r.otherAgentId === agentId);
    }
    return state.relationships;
}

/**
 * Add or update a relationship
 */
export function setRelationship(sessionId: string, relationship: Relationship): void {
    const state = worldStates.get(sessionId);
    if (!state) return;
    
    // Remove existing relationship between these agents
    state.relationships = state.relationships.filter(
        r => !(r.agentId === relationship.agentId && r.otherAgentId === relationship.otherAgentId)
    );
    
    state.relationships.push(relationship);
}

// ============================================
// Inventory queries
// ============================================

/**
 * Get inventory for an agent
 */
export function getInventory(sessionId: string, agentId: string): InventoryItem[] {
    const state = worldStates.get(sessionId);
    if (!state) return [];
    
    return state.inventories.get(agentId) ?? [];
}

/**
 * Update inventory for an agent
 */
export function setInventory(sessionId: string, agentId: string, items: InventoryItem[]): void {
    const state = worldStates.get(sessionId);
    if (!state) return;
    
    state.inventories.set(agentId, items);
}

/**
 * Add an item to an agent's inventory
 */
export function addInventoryItem(sessionId: string, agentId: string, item: InventoryItem): void {
    const state = worldStates.get(sessionId);
    if (!state) return;
    
    const inventory = state.inventories.get(agentId) ?? [];
    const existing = inventory.find(i => i.resource === item.resource);
    
    if (existing) {
        existing.quantity += item.quantity;
    } else {
        inventory.push({ ...item });
    }
    
    state.inventories.set(agentId, inventory);
}

// ============================================
// Location queries
// ============================================

/**
 * Get current location for an agent
 */
export function getAgentLocation(sessionId: string, agentId: string): Location | null {
    const state = worldStates.get(sessionId);
    if (!state) return null;
    
    return state.locations.find(l => l.occupants.includes(agentId)) ?? null;
}

/**
 * Get all locations
 */
export function getLocations(sessionId: string): Location[] {
    const state = worldStates.get(sessionId);
    if (!state) return [];
    return state.locations;
}

/**
 * Add a location
 */
export function addLocation(sessionId: string, location: Location): void {
    const state = worldStates.get(sessionId);
    if (!state) return;
    
    state.locations.push(location);
}

/**
 * Move an agent to a location
 */
export function moveAgent(sessionId: string, agentId: string, toLocation: string): void {
    const state = worldStates.get(sessionId);
    if (!state) return;
    
    // Remove from current location
    for (const loc of state.locations) {
        loc.occupants = loc.occupants.filter(id => id !== agentId);
    }
    
    // Add to new location
    const targetLoc = state.locations.find(l => l.name === toLocation);
    if (targetLoc) {
        targetLoc.occupants.push(agentId);
        
        // Record movement event
        addWorldEvent(sessionId, {
            type: 'movement',
            description: `moved to ${toLocation}`,
            participants: [agentId],
            round: 0,
            timestamp: new Date().toISOString(),
        });
    }
}

// ============================================
// Event logging
// ============================================

/**
 * Add a world event
 */
export function addWorldEvent(sessionId: string, event: WorldEvent): void {
    const state = worldStates.get(sessionId);
    if (!state) return;
    
    state.events.push(event);
    
    // Keep only last 50 events
    if (state.events.length > 50) {
        state.events = state.events.slice(-50);
    }
}

/**
 * Get recent world events
 */
export function getRecentEvents(sessionId: string, limit: number = 10): WorldEvent[] {
    const state = worldStates.get(sessionId);
    if (!state) return [];
    
    return state.events.slice(-limit);
}

// ============================================
// Serialization for API
// ============================================

/**
 * Serialize world state for API response
 */
export function serializeWorldState(sessionId: string): object | null {
    const state = worldStates.get(sessionId);
    if (!state) return null;
    
    return {
        relationships: state.relationships,
        inventories: Object.fromEntries(state.inventories),
        locations: state.locations,
        recent_events: state.events.slice(-10).map(e => ({
            type: e.type,
            description: e.description,
            participants: e.participants,
            round: e.round,
            timestamp: e.timestamp,
        })),
    };
}
