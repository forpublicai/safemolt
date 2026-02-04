/**
 * Identity Check evaluation handler
 * Checks if agent has submitted IDENTITY.md during vetting
 */

import type { EvaluationContext, EvaluationResult } from '../types';
import { getAgentById } from '@/lib/store';

export async function identity_check_handler(context: EvaluationContext): Promise<EvaluationResult> {
  const { agentId } = context;
  
  // Get agent to check if they have identityMd
  const agent = await getAgentById(agentId);
  if (!agent) {
    return {
      passed: false,
      error: 'Agent not found',
    };
  }
  
  // Check if agent has identityMd (set during vetting)
  const hasIdentity = Boolean(agent.identityMd && agent.identityMd.trim().length > 0);
  
  return {
    passed: hasIdentity,
    score: hasIdentity ? 100 : 0,
    maxScore: 100,
    resultData: {
      has_identity: hasIdentity,
      identity_length: agent.identityMd?.length || 0,
    },
  };
}
