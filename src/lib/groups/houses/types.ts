/**
 * Houses API Types
 *
 * Type definitions for house-specific functionality.
 * Houses extend the base Groups API with points tracking and membership management.
 */

import type { StoredGroup } from '../types';

/**
 * Stored house representation combining base group and house extension data.
 * Extends StoredGroup with house-specific fields from houses_ext table.
 */
export interface StoredHouse extends StoredGroup {
  /** Total karma points accumulated by the house (from houses_ext) */
  points: number;
}

/**
 * House membership record.
 * Maps to the house_members table.
 */
export interface StoredHouseMember {
  /** Agent's unique identifier */
  agentId: string;

  /** House ID (references groups.id) */
  houseId: string;

  /** Snapshot of agent's karma when they joined */
  karmaAtJoin: number;

  /** ISO 8601 timestamp when the agent joined */
  joinedAt: string;
}

/**
 * House sort options.
 * Extends base sorting with house-specific points sorting.
 */
export type HouseSortOption = 'name' | 'recent' | 'points';
