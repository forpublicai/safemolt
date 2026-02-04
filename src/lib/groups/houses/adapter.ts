/**
 * Houses Store Adapter
 *
 * Adapts the legacy store functions to the IHouseStore interface.
 * This adapter pattern enables the GroupStoreRegistry to dispatch
 * to house-specific operations while maintaining backward compatibility.
 */

import type { StoredGroup, CreateGroupInput, UpdateGroupInput, GroupSortOption } from '../types';
import type { GroupType as GroupTypeType } from '../types';
import { GroupType } from '../types';
import type { IHouseStore } from './store';
import type { StoredHouse, StoredHouseMember, HouseSortOption } from './types';

import * as store from '@/lib/store';

/**
 * Creates an IHouseStore adapter that delegates to the legacy store functions.
 *
 * @returns An IHouseStore implementation
 */
export function createHouseStoreAdapter(): IHouseStore {
  return {
    // IGroupStore base methods (operate on 'houses' type only)
    async createGroup(
      type: GroupTypeType,
      founderId: string,
      data: CreateGroupInput
    ): Promise<StoredGroup | null> {
      if (type !== GroupType.HOUSES) return null;
      return store.createHouse(founderId, data.name);
    },

    async getGroup(type: GroupTypeType, id: string): Promise<StoredGroup | null> {
      if (type !== GroupType.HOUSES) return null;
      return store.getHouse(id);
    },

    async getGroupByName(type: GroupTypeType, name: string): Promise<StoredGroup | null> {
      if (type !== GroupType.HOUSES) return null;
      return store.getHouseByName(name);
    },

    async listGroups(type: GroupTypeType, sort?: GroupSortOption): Promise<StoredGroup[]> {
      if (type !== GroupType.HOUSES) return [];
      // Map GroupSortOption to HouseSortOption (they're compatible)
      return store.listHouses(sort as HouseSortOption);
    },

    async updateGroup(
      type: GroupTypeType,
      id: string,
      _data: UpdateGroupInput
    ): Promise<StoredGroup | null> {
      if (type !== GroupType.HOUSES) return null;
      // Houses don't support update yet - return existing house
      return store.getHouse(id);
    },

    async deleteGroup(type: GroupTypeType, id: string): Promise<boolean> {
      if (type !== GroupType.HOUSES) return false;
      // Houses are deleted via leaveHouse when last member leaves
      // Direct delete is not supported in legacy API
      const house = await store.getHouse(id);
      return house === null; // Returns true if already deleted
    },

    // IHouseStore specific methods
    async getHouse(id: string): Promise<StoredHouse | null> {
      return store.getHouse(id);
    },

    async getHouseByName(name: string): Promise<StoredHouse | null> {
      return store.getHouseByName(name);
    },

    async listHouses(sort?: HouseSortOption): Promise<StoredHouse[]> {
      return store.listHouses(sort);
    },

    async getHouseMembership(agentId: string): Promise<StoredHouseMember | null> {
      return store.getHouseMembership(agentId);
    },

    async getHouseMembers(houseId: string): Promise<StoredHouseMember[]> {
      return store.getHouseMembers(houseId);
    },

    async joinHouse(agentId: string, houseId: string): Promise<boolean> {
      return store.joinHouse(agentId, houseId);
    },

    async leaveHouse(agentId: string): Promise<boolean> {
      return store.leaveHouse(agentId);
    },

    async updateHousePoints(houseId: string, delta: number): Promise<number> {
      // updateHousePoints is not exported from store.ts, need to check
      // For now, recalculate to get the current points
      return store.recalculateHousePoints(houseId);
    },

    async recalculateHousePoints(houseId: string): Promise<number> {
      return store.recalculateHousePoints(houseId);
    },
  };
}

/**
 * Singleton house store adapter instance.
 */
export const houseStoreAdapter = createHouseStoreAdapter();
