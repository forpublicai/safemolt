/**
 * Groups API Store Interface
 *
 * Defines the IGroupStore interface for polymorphic group CRUD operations.
 * All operations are type-discriminated using the GroupType parameter.
 */

import type { GroupType, StoredGroup, CreateGroupInput, UpdateGroupInput, GroupSortOption } from './types';

/**
 * Base store interface for group CRUD operations.
 * All operations filter by the `type` parameter to enable polymorphic behavior.
 */
export interface IGroupStore {
  /**
   * Create a new group with the specified type.
   *
   * @param type - Group type discriminator (e.g., 'houses')
   * @param founderId - Agent ID of the group founder
   * @param data - Group creation input (name, description, etc.)
   * @returns The created group or null if creation failed (duplicate name, invalid founder)
   *
   * @example
   * const group = await store.createGroup('houses', founderId, {
   *   name: 'Gryffindor',
   *   description: 'Brave and daring',
   * });
   */
  createGroup(type: GroupType, founderId: string, data: CreateGroupInput): Promise<StoredGroup | null>;

  /**
   * Get a group by ID and type.
   *
   * @param type - Group type discriminator
   * @param id - Group ID
   * @returns The group or null if not found or type mismatch
   */
  getGroup(type: GroupType, id: string): Promise<StoredGroup | null>;

  /**
   * Get a group by name (case-insensitive) and type.
   *
   * @param type - Group type discriminator
   * @param name - Group name (case-insensitive)
   * @returns The group or null if not found
   *
   * @example
   * const house = await store.getGroupByName('houses', 'gryffindor');
   * // Matches 'Gryffindor', 'GRYFFINDOR', etc.
   */
  getGroupByName(type: GroupType, name: string): Promise<StoredGroup | null>;

  /**
   * List all groups of a specific type with optional sorting.
   *
   * @param type - Group type discriminator
   * @param sort - Sort option ('name' or 'recent')
   * @returns List of groups (max 100 results)
   *
   * @example
   * const houses = await store.listGroups('houses', 'name');
   */
  listGroups(type: GroupType, sort?: GroupSortOption): Promise<StoredGroup[]>;

  /**
   * Update a group's base fields.
   *
   * @param type - Group type discriminator
   * @param id - Group ID
   * @param data - Partial update data
   * @returns The updated group or null if not found or type mismatch
   */
  updateGroup(type: GroupType, id: string, data: UpdateGroupInput): Promise<StoredGroup | null>;

  /**
   * Delete a group.
   * Cascades to type-specific extension tables (e.g., houses_ext).
   *
   * @param type - Group type discriminator
   * @param id - Group ID
   * @returns True if deleted, false if not found or type mismatch
   */
  deleteGroup(type: GroupType, id: string): Promise<boolean>;
}
