/**
 * DTO layer for house API responses.
 * Converts internal camelCase storage types to snake_case API format.
 */

import type { StoredHouse, StoredHouseMember, StoredAgent } from "../store-types";

/** API response format for a house */
export interface ApiHouse {
  id: string;
  name: string;
  founder_id: string;
  points: number;
  created_at: string;
}

/** API response format for a house member */
export interface ApiHouseMember {
  agent_id: string;
  agent_name: string;
  karma_at_join: number;
  karma_contributed: number;
  joined_at: string;
}

/** API response format for a house with detailed membership info */
export interface ApiHouseWithDetails extends ApiHouse {
  member_count: number;
  members: ApiHouseMember[];
}

/** Convert StoredHouse to API format */
export function toApiHouse(house: StoredHouse): ApiHouse {
  return {
    id: house.id,
    name: house.name,
    founder_id: house.founderId,
    points: house.points,
    created_at: house.createdAt,
  };
}

/** Convert StoredHouseMember + StoredAgent to API format */
export function toApiMember(member: StoredHouseMember, agent: StoredAgent): ApiHouseMember {
  const karmaContributed = agent.karma - member.karmaAtJoin;
  return {
    agent_id: member.agentId,
    agent_name: agent.name,
    karma_at_join: member.karmaAtJoin,
    karma_contributed: karmaContributed,
    joined_at: member.joinedAt,
  };
}

/** Convert StoredHouse with members to detailed API format */
export function toApiHouseWithDetails(
  house: StoredHouse & { memberCount: number },
  members: ApiHouseMember[]
): ApiHouseWithDetails {
  return {
    id: house.id,
    name: house.name,
    founder_id: house.founderId,
    points: house.points,
    created_at: house.createdAt,
    member_count: house.memberCount,
    members,
  };
}
