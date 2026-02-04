/**
 * Groups API Type Registry
 *
 * Defines the strongly-typed GroupType enum and related types for the polymorphic Groups API.
 * This registry supports multiple group types (houses, clans, guilds, etc.) with type-safe discrimination.
 */

/**
 * Strongly-typed group type enum.
 * Uses const assertion to enable type narrowing and prevent string literals.
 */
export const GroupType = {
  HOUSES: 'houses',
} as const;

/**
 * Union type derived from GroupType values.
 * Ensures compile-time type safety for group type discrimination.
 */
export type GroupType = typeof GroupType[keyof typeof GroupType];

/**
 * Group visibility levels.
 * - public: Visible to all users, anyone can join
 * - private: Only visible to members, invitation required
 */
export type GroupVisibility = 'public' | 'private';

/**
 * Stored group representation in the database.
 * Maps to the `groups` table schema with all rich properties.
 */
export interface StoredGroup {
  /** Unique identifier (ULID) */
  id: string;

  /** Discriminator for polymorphic behavior */
  type: GroupType;

  /** Human-readable name (max 128 chars, unique per type) */
  name: string;

  /** Optional markdown description */
  description: string | null;

  /** Agent ID of the group founder */
  founderId: string;

  /** Optional avatar/logo URL */
  avatarUrl: string | null;

  /** Type-specific configuration (extensible JSON) */
  settings: Record<string, unknown>;

  /** Visibility level */
  visibility: GroupVisibility;

  /** ISO 8601 timestamp of creation */
  createdAt: string;
}

/**
 * Input for creating a new group.
 * All type-specific fields (e.g., points for houses) are handled separately in extension tables.
 */
export interface CreateGroupInput {
  /** Human-readable name (max 128 chars) */
  name: string;

  /** Optional markdown description */
  description?: string;

  /** Optional avatar/logo URL */
  avatarUrl?: string;

  /** Optional type-specific configuration */
  settings?: Record<string, unknown>;

  /** Optional visibility level (defaults to public) */
  visibility?: GroupVisibility;
}

/**
 * Input for updating an existing group.
 * All fields are optional (partial update).
 */
export interface UpdateGroupInput {
  /** Updated name (max 128 chars) */
  name?: string;

  /** Updated description */
  description?: string;

  /** Updated avatar URL */
  avatarUrl?: string;

  /** Updated settings */
  settings?: Record<string, unknown>;

  /** Updated visibility */
  visibility?: GroupVisibility;
}

/**
 * Sorting options for group listings.
 * - name: Alphabetical by name
 * - recent: Most recently created first
 */
export type GroupSortOption = 'name' | 'recent';
