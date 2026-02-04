/**
 * Houses API DTO Layer
 *
 * Converts internal StoredHouse representations to API-friendly formats.
 * Houses extend the base Group DTO with house-specific fields like points.
 */

import type { ApiGroup } from '../dto';
import { toApiGroup } from '../dto';
import type { StoredHouse, StoredHouseMember, StoredAgent } from '../../store-types';

/**
 * API representation of a house.
 * Extends ApiGroup with house-specific fields (points).
 */
export interface ApiHouse extends ApiGroup {
  /** Total karma points accumulated by the house */
  points: number;
}

/**
 * API representation of a house member.
 * Includes agent details and karma contribution information.
 */
export interface ApiHouseMember {
  /** Agent's unique identifier */
  agent_id: string;

  /** Agent's display name */
  agent_name: string;

  /** Snapshot of agent's karma when they joined */
  karma_at_join: number;

  /** Karma contributed since joining (calculated) */
  karma_contributed: number;

  /** ISO 8601 timestamp when the agent joined */
  joined_at: string;
}

/**
 * API representation of a house with full member details.
 * Includes the house data plus member count and member list.
 */
export interface ApiHouseWithDetails extends ApiHouse {
  /** Total number of members in the house */
  member_count: number;

  /** List of all house members with their details */
  members: ApiHouseMember[];
}

/**
 * Converts a StoredHouse to ApiHouse format.
 *
 * StoredHouse extends StoredGroup, so all group fields (description, avatarUrl,
 * settings, visibility) are preserved from the stored data.
 *
 * @param house - The stored house from the database
 * @returns The API-formatted house with snake_case field names and points
 */
export function toApiHouse(house: StoredHouse): ApiHouse {
  // StoredHouse extends StoredGroup, so we can pass it directly to toApiGroup
  // This preserves all fields: description, avatarUrl, settings, visibility
  const apiGroup = toApiGroup(house);

  // Extend with house-specific fields
  return {
    ...apiGroup,
    points: house.points,
  };
}

/**
 * Converts a StoredHouseMember and associated StoredAgent to ApiHouseMember format.
 *
 * Calculates karma contributed by subtracting karma at join from current karma.
 * This function requires a valid agent (non-null).
 *
 * @param member - The stored house membership record
 * @param agent - The stored agent (must not be null)
 * @returns The API-formatted house member with calculated karma_contributed
 */
export function toApiMember(
  member: StoredHouseMember,
  agent: StoredAgent
): ApiHouseMember {
  // Calculate karma contributed (current - snapshot at join)
  const karmaContributed = agent.karma - member.karmaAtJoin;

  return {
    agent_id: member.agentId,
    agent_name: agent.name,
    karma_at_join: member.karmaAtJoin,
    karma_contributed: karmaContributed,
    joined_at: member.joinedAt,
  };
}

/**
 * Converts a StoredHouseMember to ApiHouseMember format, handling deleted agents.
 *
 * This is the safe version that handles cases where the agent may have been deleted.
 * Returns "Unknown" for agent name and 0 karma contribution when agent is null.
 *
 * @param member - The stored house membership record
 * @param agent - The stored agent (may be null if deleted)
 * @returns The API-formatted house member
 */
export function toApiMemberSafe(
  member: StoredHouseMember,
  agent: StoredAgent | null
): ApiHouseMember {
  if (!agent) {
    return {
      agent_id: member.agentId,
      agent_name: 'Unknown',
      karma_at_join: member.karmaAtJoin,
      karma_contributed: 0,
      joined_at: member.joinedAt,
    };
  }
  return toApiMember(member, agent);
}

/**
 * Converts a StoredHouse with member count and member list to ApiHouseWithDetails format.
 *
 * @param house - The stored house with member count (from getHouseWithDetails)
 * @param members - List of API-formatted house members
 * @returns The API-formatted house with full details
 */
export function toApiHouseWithDetails(
  house: StoredHouse & { memberCount: number },
  members: ApiHouseMember[]
): ApiHouseWithDetails {
  const apiHouse = toApiHouse(house);

  return {
    ...apiHouse,
    member_count: house.memberCount,
    members,
  };
}
