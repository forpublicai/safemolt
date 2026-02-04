/**
 * Unit tests for GroupStoreRegistry
 * @jest-environment node
 */
import { GroupStoreRegistry, initializeGroupStoreRegistry } from '@/lib/groups/registry';
import { GroupType } from '@/lib/groups/types';
import type { IGroupStore } from '@/lib/groups/store';
import type { IHouseStore } from '@/lib/groups/houses/store';

// Mock the houseStoreAdapter to avoid database dependencies
jest.mock('@/lib/groups/houses/adapter', () => ({
  houseStoreAdapter: {
    getHouse: jest.fn(),
    getHouseByName: jest.fn(),
    listHouses: jest.fn(),
    getHouseMembership: jest.fn(),
    getHouseMembers: jest.fn(),
    joinHouse: jest.fn(),
    leaveHouse: jest.fn(),
    updateHousePoints: jest.fn(),
    recalculateHousePoints: jest.fn(),
    createGroup: jest.fn(),
    getGroup: jest.fn(),
    getGroupByName: jest.fn(),
    listGroups: jest.fn(),
    updateGroup: jest.fn(),
    deleteGroup: jest.fn(),
  } as IHouseStore,
}));

describe('GroupStoreRegistry', () => {
  beforeEach(() => {
    // Clear the registry before each test to ensure clean state
    GroupStoreRegistry.clear();
  });

  afterEach(() => {
    // Re-initialize the registry after each test to restore default state
    initializeGroupStoreRegistry();
  });

  describe('getHandler', () => {
    it('returns IHouseStore for registered "houses" type', () => {
      // Arrange: Initialize registry with houses handler
      initializeGroupStoreRegistry();

      // Act: Get the handler for houses
      const handler = GroupStoreRegistry.getHandler(GroupType.HOUSES);

      // Assert: Handler exists and has house-specific methods
      expect(handler).not.toBeNull();
      expect(handler).toHaveProperty('getHouse');
      expect(handler).toHaveProperty('getHouseByName');
      expect(handler).toHaveProperty('listHouses');
      expect(handler).toHaveProperty('getHouseMembership');
      expect(handler).toHaveProperty('getHouseMembers');
      expect(handler).toHaveProperty('joinHouse');
      expect(handler).toHaveProperty('leaveHouse');
      expect(handler).toHaveProperty('updateHousePoints');
      expect(handler).toHaveProperty('recalculateHousePoints');
    });

    it('returns null for unregistered types', () => {
      // Arrange: Clear registry (no handlers registered)
      GroupStoreRegistry.clear();

      // Act: Try to get handler for houses (not registered)
      const handler = GroupStoreRegistry.getHandler(GroupType.HOUSES);

      // Assert: No handler found
      expect(handler).toBeNull();
    });

    it('returns null for unregistered "clans" type', () => {
      // Arrange: Initialize registry with only houses
      initializeGroupStoreRegistry();

      // Act: Try to get handler for clans (not a valid GroupType yet, but tests future extensibility)
      // @ts-expect-error - Testing with a type that doesn't exist yet
      const handler = GroupStoreRegistry.getHandler('clans');

      // Assert: No handler found for unregistered type
      expect(handler).toBeNull();
    });
  });

  describe('hasHandler', () => {
    it('returns true for registered types', () => {
      // Arrange: Initialize registry with houses
      initializeGroupStoreRegistry();

      // Act & Assert: Check if houses handler is registered
      expect(GroupStoreRegistry.hasHandler(GroupType.HOUSES)).toBe(true);
    });

    it('returns false for unregistered types', () => {
      // Arrange: Clear registry
      GroupStoreRegistry.clear();

      // Act & Assert: Check if houses handler exists (should not)
      expect(GroupStoreRegistry.hasHandler(GroupType.HOUSES)).toBe(false);
    });

    it('returns false for future unregistered types', () => {
      // Arrange: Initialize registry with only houses
      initializeGroupStoreRegistry();

      // Act & Assert: Check for a type that doesn't exist
      // @ts-expect-error - Testing with a type that doesn't exist yet
      expect(GroupStoreRegistry.hasHandler('clans')).toBe(false);
      // @ts-expect-error - Testing with a type that doesn't exist yet
      expect(GroupStoreRegistry.hasHandler('guilds')).toBe(false);
    });
  });

  describe('register', () => {
    it('adds a store handler for a specific type', () => {
      // Arrange: Create a mock store
      const mockStore: IGroupStore = {
        createGroup: jest.fn(),
        getGroup: jest.fn(),
        getGroupByName: jest.fn(),
        listGroups: jest.fn(),
        updateGroup: jest.fn(),
        deleteGroup: jest.fn(),
      };

      // Act: Register the mock store
      GroupStoreRegistry.register(GroupType.HOUSES, mockStore);

      // Assert: Handler is registered and retrievable
      expect(GroupStoreRegistry.hasHandler(GroupType.HOUSES)).toBe(true);
      const handler = GroupStoreRegistry.getHandler(GroupType.HOUSES);
      expect(handler).toBe(mockStore);
    });

    it('allows registering multiple store types', () => {
      // Arrange: Create mock stores
      const houseStore: IGroupStore = {
        createGroup: jest.fn(),
        getGroup: jest.fn(),
        getGroupByName: jest.fn(),
        listGroups: jest.fn(),
        updateGroup: jest.fn(),
        deleteGroup: jest.fn(),
      };
      const clanStore: IGroupStore = {
        createGroup: jest.fn(),
        getGroup: jest.fn(),
        getGroupByName: jest.fn(),
        listGroups: jest.fn(),
        updateGroup: jest.fn(),
        deleteGroup: jest.fn(),
      };

      // Act: Register both stores
      GroupStoreRegistry.register(GroupType.HOUSES, houseStore);
      // @ts-expect-error - Testing future extensibility
      GroupStoreRegistry.register('clans', clanStore);

      // Assert: Both handlers are registered
      expect(GroupStoreRegistry.hasHandler(GroupType.HOUSES)).toBe(true);
      // @ts-expect-error - Testing future extensibility
      expect(GroupStoreRegistry.hasHandler('clans')).toBe(true);
      expect(GroupStoreRegistry.getHandler(GroupType.HOUSES)).toBe(houseStore);
      // @ts-expect-error - Testing future extensibility
      expect(GroupStoreRegistry.getHandler('clans')).toBe(clanStore);
    });

    it('overwrites existing handler when registering same type', () => {
      // Arrange: Create two different stores
      const store1: IGroupStore = {
        createGroup: jest.fn().mockResolvedValue({ id: 'store1' }),
        getGroup: jest.fn(),
        getGroupByName: jest.fn(),
        listGroups: jest.fn(),
        updateGroup: jest.fn(),
        deleteGroup: jest.fn(),
      };
      const store2: IGroupStore = {
        createGroup: jest.fn().mockResolvedValue({ id: 'store2' }),
        getGroup: jest.fn(),
        getGroupByName: jest.fn(),
        listGroups: jest.fn(),
        updateGroup: jest.fn(),
        deleteGroup: jest.fn(),
      };

      // Act: Register first store, then overwrite with second
      GroupStoreRegistry.register(GroupType.HOUSES, store1);
      GroupStoreRegistry.register(GroupType.HOUSES, store2);

      // Assert: Second store overwrites the first
      const handler = GroupStoreRegistry.getHandler(GroupType.HOUSES);
      expect(handler).toBe(store2);
      expect(handler).not.toBe(store1);
    });
  });

  describe('clear', () => {
    it('removes all registered handlers', () => {
      // Arrange: Initialize registry with handlers
      initializeGroupStoreRegistry();
      expect(GroupStoreRegistry.hasHandler(GroupType.HOUSES)).toBe(true);

      // Act: Clear all handlers
      GroupStoreRegistry.clear();

      // Assert: No handlers remain
      expect(GroupStoreRegistry.hasHandler(GroupType.HOUSES)).toBe(false);
      expect(GroupStoreRegistry.getHandler(GroupType.HOUSES)).toBeNull();
    });

    it('allows re-registration after clearing', () => {
      // Arrange: Initialize, clear, then re-initialize
      initializeGroupStoreRegistry();
      GroupStoreRegistry.clear();

      // Act: Re-initialize registry
      initializeGroupStoreRegistry();

      // Assert: Handler is re-registered
      expect(GroupStoreRegistry.hasHandler(GroupType.HOUSES)).toBe(true);
      expect(GroupStoreRegistry.getHandler(GroupType.HOUSES)).not.toBeNull();
    });

    it('clears multiple registered handlers', () => {
      // Arrange: Register multiple stores
      const store1: IGroupStore = {
        createGroup: jest.fn(),
        getGroup: jest.fn(),
        getGroupByName: jest.fn(),
        listGroups: jest.fn(),
        updateGroup: jest.fn(),
        deleteGroup: jest.fn(),
      };
      const store2: IGroupStore = {
        createGroup: jest.fn(),
        getGroup: jest.fn(),
        getGroupByName: jest.fn(),
        listGroups: jest.fn(),
        updateGroup: jest.fn(),
        deleteGroup: jest.fn(),
      };
      GroupStoreRegistry.register(GroupType.HOUSES, store1);
      // @ts-expect-error - Testing future extensibility
      GroupStoreRegistry.register('clans', store2);

      // Act: Clear all handlers
      GroupStoreRegistry.clear();

      // Assert: All handlers are removed
      expect(GroupStoreRegistry.hasHandler(GroupType.HOUSES)).toBe(false);
      // @ts-expect-error - Testing future extensibility
      expect(GroupStoreRegistry.hasHandler('clans')).toBe(false);
    });
  });

  describe('initializeGroupStoreRegistry', () => {
    it('registers houses handler on module load', () => {
      // Arrange: Start with cleared registry
      GroupStoreRegistry.clear();

      // Act: Call initialization function
      initializeGroupStoreRegistry();

      // Assert: Houses handler is registered
      expect(GroupStoreRegistry.hasHandler(GroupType.HOUSES)).toBe(true);
      const handler = GroupStoreRegistry.getHandler(GroupType.HOUSES);
      expect(handler).not.toBeNull();
    });

    it('can be called multiple times without error', () => {
      // Act & Assert: Multiple initializations should not throw
      expect(() => {
        initializeGroupStoreRegistry();
        initializeGroupStoreRegistry();
        initializeGroupStoreRegistry();
      }).not.toThrow();

      // Verify handler is still registered
      expect(GroupStoreRegistry.hasHandler(GroupType.HOUSES)).toBe(true);
    });

    it('registers houseStoreAdapter with correct interface', () => {
      // Arrange: Clear and re-initialize
      GroupStoreRegistry.clear();
      initializeGroupStoreRegistry();

      // Act: Get the registered handler
      const handler = GroupStoreRegistry.getHandler(GroupType.HOUSES);

      // Assert: Handler implements IHouseStore interface
      expect(handler).not.toBeNull();
      if (handler) {
        // Check IGroupStore base methods
        expect(typeof handler.createGroup).toBe('function');
        expect(typeof handler.getGroup).toBe('function');
        expect(typeof handler.getGroupByName).toBe('function');
        expect(typeof handler.listGroups).toBe('function');
        expect(typeof handler.updateGroup).toBe('function');
        expect(typeof handler.deleteGroup).toBe('function');

        // Check IHouseStore specific methods
        expect(typeof handler.getHouse).toBe('function');
        expect(typeof handler.getHouseByName).toBe('function');
        expect(typeof handler.listHouses).toBe('function');
        expect(typeof handler.getHouseMembership).toBe('function');
        expect(typeof handler.getHouseMembers).toBe('function');
        expect(typeof handler.joinHouse).toBe('function');
        expect(typeof handler.leaveHouse).toBe('function');
        expect(typeof handler.updateHousePoints).toBe('function');
        expect(typeof handler.recalculateHousePoints).toBe('function');
      }
    });
  });

  describe('type safety', () => {
    it('getHandler returns correctly typed store for houses', () => {
      // Arrange: Initialize registry
      initializeGroupStoreRegistry();

      // Act: Get handler with type parameter
      const handler = GroupStoreRegistry.getHandler(GroupType.HOUSES);

      // Assert: TypeScript should infer IHouseStore | null
      // This test verifies the StoreForType conditional type works correctly
      if (handler) {
        // These methods should be available on IHouseStore
        expect(handler).toHaveProperty('getHouse');
        expect(handler).toHaveProperty('updateHousePoints');
      }
    });

    it('maintains singleton pattern for registered stores', () => {
      // Arrange: Initialize registry
      initializeGroupStoreRegistry();

      // Act: Get handler multiple times
      const handler1 = GroupStoreRegistry.getHandler(GroupType.HOUSES);
      const handler2 = GroupStoreRegistry.getHandler(GroupType.HOUSES);

      // Assert: Same instance returned (singleton pattern)
      expect(handler1).toBe(handler2);
    });
  });
});
