/**
 * Loader for evaluation Markdown files
 * Supports school scoping: looks in schools/{schoolId}/evaluations/
 */

import { readFileSync, readdirSync, statSync, existsSync } from 'fs';
import { join } from 'path';
import { parseEvaluationFile, extractDescription } from './parser';
import type { EvaluationDefinition, EvaluationListItem } from './types';

// Per-school cache
const evaluationsCacheMap = new Map<string, Map<string, EvaluationDefinition>>();
const cacheTimestamps = new Map<string, number>();

/**
 * Load all evaluation files from a school directory
 */
export function loadEvaluations(
  schoolId = 'foundation',
  forceReload = false
): Map<string, EvaluationDefinition> {
  // Legacy support: if schoolId is 'foundation' and we have specific files in /evaluations, 
  // we might want to load them. But the plan is to move them to schools/foundation/evaluations.
  
  const evaluationsDir = schoolId === 'legacy' 
    ? join(process.cwd(), 'evaluations')
    : join(process.cwd(), 'schools', schoolId, 'evaluations');
  
  // Check if cache is still valid
  const schoolCache = evaluationsCacheMap.get(schoolId);
  const schoolTimestamp = cacheTimestamps.get(schoolId) || 0;

  if (!forceReload && schoolCache) {
    try {
      if (existsSync(evaluationsDir)) {
        const dirStat = statSync(evaluationsDir);
        if (dirStat.mtimeMs <= schoolTimestamp) {
          return schoolCache;
        }
      } else {
        return new Map();
      }
    } catch {
      // Directory doesn't exist or can't be read
    }
  }
  
  const evaluations = new Map<string, EvaluationDefinition>();
  
  try {
    if (existsSync(evaluationsDir)) {
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
          console.error(`Error loading evaluation file ${file} for school ${schoolId}:`, error);
        }
      }
    }
    
    // Also merge from legacy root evaluations directory if school is foundation
    if (schoolId === 'foundation') {
      const legacyDir = join(process.cwd(), 'evaluations');
      if (existsSync(legacyDir)) {
        const legacyFiles = readdirSync(legacyDir);
        for (const file of legacyFiles) {
          if (!file.endsWith('.md') || file === 'README.md') continue;
          const filePath = join(legacyDir, file);
          try {
            const content = readFileSync(filePath, 'utf-8');
            const evaluation = parseEvaluationFile(content, file);
            if (evaluation.status !== 'deprecated' && !evaluations.has(evaluation.id)) {
              evaluations.set(evaluation.id, evaluation);
            }
          } catch (error) {
            console.error(`Error loading legacy evaluation file ${file}:`, error);
          }
        }
      }
    }
    
    evaluationsCacheMap.set(schoolId, evaluations);
    cacheTimestamps.set(schoolId, Date.now());
  } catch (error) {
    console.error(`Error loading evaluations directory for school ${schoolId}:`, error);
  }
  
  return evaluations;
}

/**
 * Get a single evaluation by ID, within a school
 */
export function getEvaluation(id: string, schoolId = 'foundation'): EvaluationDefinition | null {
  const evaluations = loadEvaluations(schoolId);
  return evaluations.get(id) || null;
}

/**
 * Get evaluation by SIP number, within a school
 */
export function getEvaluationBySip(sipNumber: number, schoolId = 'foundation'): EvaluationDefinition | null {
  const evaluations = loadEvaluations(schoolId);
  const list = Array.from(evaluations.values());
  for (const e of list) {
    if (e.sip === sipNumber) return e;
  }
  return null;
}

/**
 * List all evaluations as EvaluationListItem for a school
 */
export function listEvaluations(
  schoolId = 'foundation',
  module?: string,
  status: 'active' | 'draft' | 'deprecated' | 'all' = 'active'
): EvaluationListItem[] {
  const evaluations = loadEvaluations(schoolId);
  const items: EvaluationListItem[] = [];
  
  const evaluationArray = Array.from(evaluations.values());
  
  for (const evaluation of evaluationArray) {
    if (module && evaluation.module !== module) {
      continue;
    }
    
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
  
  items.sort((a, b) => a.sip - b.sip);
  
  return items;
}

/**
 * Get all evaluation IDs for a school
 */
export function getAllEvaluationIds(schoolId = 'foundation'): string[] {
  const evaluations = loadEvaluations(schoolId);
  return Array.from(evaluations.keys());
}
