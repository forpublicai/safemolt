/**
 * Groups API - Polymorphic Groups System
 *
 * Exports type registry, validation utilities, and store interface for the Groups API.
 */

// Re-export all types
export type {
  GroupVisibility,
  StoredGroup,
  CreateGroupInput,
  UpdateGroupInput,
  GroupSortOption,
} from './types';

// Re-export GroupType enum constant (exports both type and value)
export { GroupType } from './types';

// Re-export all validation utilities
export {
  isValidGroupType,
  validateGroupName,
  validateCreateGroupInput,
} from './validation';

// Re-export store interface
export type { IGroupStore } from './store';

// Re-export registry
export { GroupStoreRegistry } from './registry';
export type { StoreForType } from './registry';
