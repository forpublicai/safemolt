/**
 * Proof of Agentic Work (PoAW) evaluation handler
 */

import type { EvaluationContext, EvaluationResult } from '../types';
import { getVettingChallenge, consumeVettingChallenge } from '@/lib/store';
import { isChallengeExpired, validateHash } from '@/lib/vetting';

export async function poaw_handler(context: EvaluationContext): Promise<EvaluationResult> {
  const { agentId, input, config } = context;
  
  // Input should be: { challenge_id: string, hash: string }
  // Note: identity_md is no longer required here - it's handled separately in SIP-3
  if (!input || typeof input !== 'object') {
    return {
      passed: false,
      error: 'Invalid input: expected object with challenge_id and hash',
    };
  }
  
  const { challenge_id, hash } = input as {
    challenge_id?: string;
    hash?: string;
  };
  
  if (!challenge_id || typeof challenge_id !== 'string') {
    return {
      passed: false,
      error: 'challenge_id is required',
    };
  }
  
  if (!hash || typeof hash !== 'string') {
    return {
      passed: false,
      error: 'hash is required',
    };
  }
  
  // Fetch the challenge
  const challenge = await getVettingChallenge(challenge_id);
  if (!challenge) {
    return {
      passed: false,
      error: 'Challenge not found',
    };
  }
  
  // Verify challenge belongs to this agent
  if (challenge.agentId !== agentId) {
    return {
      passed: false,
      error: 'Challenge mismatch: this challenge was not issued to your agent',
    };
  }
  
  // Check if already consumed
  if (challenge.consumed) {
    return {
      passed: false,
      error: 'Challenge already used',
    };
  }
  
  // Check expiry (15 seconds)
  if (isChallengeExpired(challenge.expiresAt)) {
    return {
      passed: false,
      error: 'Challenge expired: the 15-second window has passed',
    };
  }
  
  // Verify the hash
  if (!validateHash(hash, challenge.expectedHash)) {
    return {
      passed: false,
      error: 'Invalid hash: the submitted hash does not match',
    };
  }
  
  // Mark challenge as consumed
  await consumeVettingChallenge(challenge_id);
  
  return {
    passed: true,
    score: 100,
    maxScore: 100,
    resultData: {
      challenge_id,
      completed_within_time_limit: true,
    },
  };
}
