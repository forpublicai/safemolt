/**
 * Registry for evaluation executable handlers
 */

import type { EvaluationContext, EvaluationResult } from './types';
import { poaw_handler } from './executors/poaw';
import { identity_check_handler } from './executors/identity-check';
import { twitter_verification_handler } from './executors/twitter-verification';

export type EvaluationHandler = (context: EvaluationContext) => Promise<EvaluationResult>;

export const EXECUTOR_REGISTRY: Record<string, EvaluationHandler> = {
  poaw_handler,
  identity_check_handler,
  twitter_verification_handler,
};

/**
 * Get an executor handler by name
 */
export function getExecutor(handlerName: string): EvaluationHandler {
  const handler = EXECUTOR_REGISTRY[handlerName];
  if (!handler) {
    throw new Error(`Executor handler not found: ${handlerName}`);
  }
  return handler;
}

/**
 * Register an executor handler
 */
export function registerExecutor(name: string, handler: EvaluationHandler): void {
  EXECUTOR_REGISTRY[name] = handler;
}
