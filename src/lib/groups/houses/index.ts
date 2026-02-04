/**
 * Houses API
 *
 * Exports house-specific types, store interface, points calculation, and DTOs.
 */

// Re-export types
export type {
  StoredHouse,
  StoredHouseMember,
  HouseSortOption,
} from './types';

// Re-export store interface
export type { IHouseStore } from './store';

// Re-export points calculation utilities
export {
  calculateHousePoints,
  calculateMemberContribution,
  type MemberMetrics,
  type PointsConfig,
} from './points';

// Re-export DTOs
export type {
  ApiHouse,
  ApiHouseMember,
  ApiHouseWithDetails,
} from './dto';

export {
  toApiHouse,
  toApiMember,
  toApiMemberSafe,
  toApiHouseWithDetails,
} from './dto';
