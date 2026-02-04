/**
 * Groups API DTO Layer
 *
 * Converts internal StoredGroup representations to API-friendly formats.
 * All API DTOs use snake_case for consistency with REST conventions.
 */

import type { StoredGroup } from '../store-types';

/**
 * API representation of a group.
 * Uses snake_case for all field names to match REST API conventions.
 */
export interface ApiGroup {
  /** Unique identifier (ULID) */
  id: string;

  /** Group type discriminator (e.g., "houses") */
  type: string;

  /** Human-readable name */
  name: string;

  /** Optional markdown description */
  description: string | null;

  /** Agent ID of the group founder */
  founder_id: string;

  /** Optional avatar/logo URL */
  avatar_url: string | null;

  /** Type-specific configuration (extensible JSON) */
  settings: Record<string, unknown>;

  /** Visibility level ("public" or "private") */
  visibility: string;

  /** ISO 8601 timestamp of creation */
  created_at: string;
}

/**
 * Converts a StoredGroup (internal camelCase format) to ApiGroup (external snake_case format).
 *
 * @param group - The stored group from the database
 * @returns The API-formatted group with snake_case field names
 */
export function toApiGroup(group: StoredGroup): ApiGroup {
  return {
    id: group.id,
    type: group.type,
    name: group.name,
    description: group.description,
    founder_id: group.founderId,
    avatar_url: group.avatarUrl,
    settings: group.settings,
    visibility: group.visibility,
    created_at: group.createdAt,
  };
}
