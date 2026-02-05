/**
 * Loader for evaluation Markdown files
 */

import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { parseEvaluationFile, extractDescription } from './parser';
import type { EvaluationDefinition, EvaluationListItem } from './types';

let evaluationsCache: Map<string, EvaluationDefinition> | null = null;
let cacheTimestamp: number = 0;

/**
 * Load all evaluation files from the evaluations directory
 */
export function loadEvaluations(forceReload = false): Map<string, EvaluationDefinition> {
  const evaluationsDir = join(process.cwd(), 'evaluations');
  
  // Check if cache is still valid (in dev, reload on file changes)
  if (!forceReload && evaluationsCache) {
    try {
      const dirStat = statSync(evaluationsDir);
      if (dirStat.mtimeMs <= cacheTimestamp) {
        return evaluationsCache;
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
  }
  
  const evaluations = new Map<string, EvaluationDefinition>();
  
  try {
    const files = readdirSync(evaluationsDir);
    
    for (const file of files) {
      if (!file.endsWith('.md') || file === 'README.md') {
        continue;
      }
      
      const filePath = join(evaluationsDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const evaluation = parseEvaluationFile(content, file);
        
        // Only load active and draft evaluations (skip deprecated unless explicitly requested)
        if (evaluation.status === 'deprecated' && !forceReload) {
          continue;
        }
        
        evaluations.set(evaluation.id, evaluation);
      } catch (error) {
        console.error(`Error loading evaluation file ${file}:`, error);
        // Continue loading other files
      }
    }
    
    evaluationsCache = evaluations;
    cacheTimestamp = Date.now();
  } catch (error) {
    console.error('Error loading evaluations directory:', error);
    // Return empty map if directory doesn't exist
  }
  
  return evaluations;
}

/**
 * Get a single evaluation by ID
 */
export function getEvaluation(id: string): EvaluationDefinition | null {
  const evaluations = loadEvaluations();
  return evaluations.get(id) || null;
}

/**
 * Get evaluation by SIP number (e.g. 5 for SIP-5). Used when route param is [sip] like "5" or "SIP-5".
 */
export function getEvaluationBySip(sipNumber: number): EvaluationDefinition | null {
  const evaluations = loadEvaluations();
  const list = Array.from(evaluations.values());
  for (const e of list) {
    if (e.sip === sipNumber) return e;
  }
  return null;
}

/**
 * List all evaluations as EvaluationListItem (for API responses)
 */
export function listEvaluations(
  module?: string,
  status: 'active' | 'draft' | 'deprecated' | 'all' = 'active'
): EvaluationListItem[] {
  const evaluations = loadEvaluations();
  const items: EvaluationListItem[] = [];
  
  // Convert Map to Array for iteration
  const evaluationArray = Array.from(evaluations.values());
  
  for (const evaluation of evaluationArray) {
    // Filter by module if specified
    if (module && evaluation.module !== module) {
      continue;
    }
    
    // Filter by status
    if (status !== 'all' && evaluation.status !== status) {
      continue;
    }
    
    const description = extractDescription(evaluation.content);
    
    items.push({
      id: evaluation.id,
      sip: evaluation.sip,
      name: evaluation.name,
      description,
      module: evaluation.module,
      type: evaluation.type,
      status: evaluation.status,
      prerequisites: evaluation.prerequisites || [],
      canRegister: evaluation.status === 'active',
    });
  }
  
  // Sort by SIP number
  items.sort((a, b) => a.sip - b.sip);
  
  return items;
}

/**
 * Get all evaluation IDs
 */
export function getAllEvaluationIds(): string[] {
  const evaluations = loadEvaluations();
  return Array.from(evaluations.keys());
}
