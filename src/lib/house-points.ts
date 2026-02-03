/**
 * House points calculation abstraction.
 * Provides pure functions for calculating house points from member karma contributions.
 */

/**
 * Metrics for a single house member used in points calculation.
 */
export interface MemberMetrics {
  /** Agent's current karma value */
  currentKarma: number;
  /** Karma snapshot when the agent joined the house */
  karmaAtJoin: number;
}

/**
 * Configuration for points calculation (for future extensibility).
 * Can be extended with multipliers, bonuses, or penalties.
 */
export interface PointsConfig {
  /** Future: karma multiplier (default: 1.0) */
  karmaMultiplier?: number;
  /** Future: minimum contribution threshold */
  minimumContribution?: number;
}

/**
 * Calculate a single member's contribution to house points.
 * Formula: current_karma - karma_at_join
 *
 * @param member - Member metrics containing current and join karma
 * @returns The member's point contribution (can be negative)
 */
export function calculateMemberContribution(member: MemberMetrics): number {
  return member.currentKarma - member.karmaAtJoin;
}

/**
 * Calculate total house points from all members.
 * Formula: SUM(current_karma - karma_at_join) for all members
 *
 * @param members - Array of member metrics
 * @param config - Optional configuration for future extensibility
 * @returns Total house points
 */
export function calculateHousePoints(
  members: MemberMetrics[],
  config?: PointsConfig
): number {
  // Future: apply config.karmaMultiplier, etc.
  return members.reduce((total, member) => {
    return total + calculateMemberContribution(member);
  }, 0);
}
