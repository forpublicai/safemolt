/**
 * Houses API Store Interface
 *
 * Defines the IHouseStore interface for house-specific operations.
 * Extends IGroupStore with house-specific membership and points management.
 */

import type { IGroupStore } from '../store';
import type { StoredHouse, StoredHouseMember, HouseSortOption } from './types';

/**
 * House store interface extending base group operations.
 * Provides house-specific operations for membership and points tracking.
 */
export interface IHouseStore extends IGroupStore {
  /**
   * Get a house by ID.
   * Overrides base getGroup to return StoredHouse with points.
   *
   * @param id - House ID
   * @returns The house with points or null if not found
   */
  getHouse(id: string): Promise<StoredHouse | null>;

  /**
   * Get a house by name (case-insensitive).
   * Overrides base getGroupByName to return StoredHouse with points.
   *
   * @param name - House name (case-insensitive)
   * @returns The house with points or null if not found
   */
  getHouseByName(name: string): Promise<StoredHouse | null>;

  /**
   * List all houses with optional sorting.
   * Supports sorting by points in addition to base sort options.
   *
   * @param sort - Sort option ('name', 'recent', or 'points')
   * @returns List of houses (max 100 results)
   */
  listHouses(sort?: HouseSortOption): Promise<StoredHouse[]>;

  /**
   * Get an agent's current house membership.
   *
   * @param agentId - Agent ID
   * @returns The membership record or null if not in a house
   */
  getHouseMembership(agentId: string): Promise<StoredHouseMember | null>;

  /**
   * Get all members of a house.
   *
   * @param houseId - House ID
   * @returns List of house members ordered by join date
   */
  getHouseMembers(houseId: string): Promise<StoredHouseMember[]>;

  /**
   * Join a house.
   * Agent leaves current house if already in one.
   * Records karma snapshot at join time for contribution tracking.
   *
   * @param agentId - Agent ID
   * @param houseId - House ID to join
   * @returns True if joined successfully, false if house doesn't exist
   */
  joinHouse(agentId: string, houseId: string): Promise<boolean>;

  /**
   * Leave current house.
   * If founder leaves, promotes oldest member or dissolves house.
   *
   * @param agentId - Agent ID
   * @returns True if left successfully, false if not in a house
   */
  leaveHouse(agentId: string): Promise<boolean>;

  /**
   * Update house points incrementally by a delta amount.
   * Used for real-time karma changes (e.g., post/comment votes).
   *
   * @param houseId - House ID
   * @param delta - Points to add (can be negative)
   * @returns Updated total points
   */
  updateHousePoints(houseId: string, delta: number): Promise<number>;

  /**
   * Recalculate house points from scratch based on member karma contributions.
   * Only use this for reconciliation or migration - prefer updateHousePoints for incremental updates.
   *
   * @param houseId - House ID
   * @returns Recalculated total points
   */
  recalculateHousePoints(houseId: string): Promise<number>;
}
