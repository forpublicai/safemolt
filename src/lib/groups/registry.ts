/**
 * Groups API Store Registry
 *
 * Provides polymorphic dispatch for group type-specific stores.
 * Uses type-conditional return types for compile-time type safety.
 */

import { GroupType } from './types';
import type { IGroupStore } from './store';
import type { IHouseStore } from './houses/store';
import { houseStoreAdapter } from './houses/adapter';

/**
 * Type-conditional return type for store dispatch.
 * Maps GroupType discriminants to their corresponding store interfaces.
 *
 * @example
 * // Returns IHouseStore for 'houses' type
 * type HouseStore = StoreForType<'houses'>; // IHouseStore
 *
 * // Returns IGroupStore for any other group type
 * type GenericStore = StoreForType<'clans'>; // IGroupStore
 */
export type StoreForType<T extends GroupType> =
  T extends 'houses' ? IHouseStore : IGroupStore;

/**
 * Internal registry map storing singleton store instances by group type.
 */
const stores: Map<GroupType, IGroupStore> = new Map();

/**
 * GroupStoreRegistry provides polymorphic dispatch for group stores.
 *
 * This registry pattern enables:
 * - Type-safe store retrieval based on group type discriminant
 * - Singleton store management per group type
 * - Runtime extensibility for new group types
 *
 * @example
 * // Register a house store
 * GroupStoreRegistry.register('houses', houseStore);
 *
 * // Retrieve with correct type inference
 * const store = GroupStoreRegistry.getHandler('houses');
 * // store is typed as IHouseStore | null
 * if (store) {
 *   await store.getHouse(id); // House-specific method available
 * }
 */
export const GroupStoreRegistry = {
  /**
   * Register a store singleton for a specific group type.
   *
   * @param type - Group type discriminant
   * @param store - Store instance implementing the type's interface
   *
   * @example
   * GroupStoreRegistry.register('houses', houseStore);
   */
  register<T extends GroupType>(type: T, store: StoreForType<T>): void {
    stores.set(type, store);
  },

  /**
   * Get the store handler for a specific group type.
   * Returns null if no store is registered for the type.
   *
   * @param type - Group type discriminant
   * @returns The type-specific store or null if not registered
   *
   * @example
   * const store = GroupStoreRegistry.getHandler('houses');
   * if (store) {
   *   const house = await store.getHouse(id);
   * }
   */
  getHandler<T extends GroupType>(type: T): StoreForType<T> | null {
    return (stores.get(type) as StoreForType<T>) ?? null;
  },

  /**
   * Check if a store is registered for a specific group type.
   *
   * @param type - Group type discriminant
   * @returns True if a store is registered
   */
  hasHandler(type: GroupType): boolean {
    return stores.has(type);
  },

  /**
   * Clear all registered stores.
   * Primarily used for testing.
   */
  clear(): void {
    stores.clear();
  },
};

/**
 * Initialize the registry with default store implementations.
 * Call this once at application startup.
 */
export function initializeGroupStoreRegistry(): void {
  GroupStoreRegistry.register(GroupType.HOUSES, houseStoreAdapter);
}

// Auto-initialize on module load
initializeGroupStoreRegistry();
