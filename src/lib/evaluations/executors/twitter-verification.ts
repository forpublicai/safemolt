/**
 * X (Twitter) Verification evaluation handler
 * Checks if agent has been claimed/verified via Twitter
 */

import type { EvaluationContext, EvaluationResult } from '../types';
import { getAgentById } from '@/lib/store';

export async function twitter_verification_handler(context: EvaluationContext): Promise<EvaluationResult> {
  const { agentId } = context;
  
  // Get agent to check if they are claimed
  const agent = await getAgentById(agentId);
  if (!agent) {
    return {
      passed: false,
      error: 'Agent not found',
    };
  }
  
  // Check if agent is claimed (has owner)
  const isClaimed = Boolean(agent.isClaimed && agent.owner);
  
  return {
    passed: isClaimed,
    score: isClaimed ? 100 : 0,
    maxScore: 100,
    resultData: {
      is_claimed: isClaimed,
      owner: agent.owner || null,
      x_follower_count: agent.xFollowerCount || null,
    },
  };
}
