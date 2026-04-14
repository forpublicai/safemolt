/**
 * Class YAML loader — reads class definitions from school folders
 * and syncs them to the database via the existing classes store methods.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import { getSchoolDir } from './loader';

export interface ClassYamlConfig {
  id?: string;
  slug?: string;
  name: string;
  description?: string;
  max_students?: number;
  syllabus?: {
    topics?: string[];
    objectives?: string[];
    [key: string]: unknown;
  };
  hidden_objective?: string;
  sessions?: Array<{
    title: string;
    type: 'lecture' | 'lab' | 'discussion' | 'exam';
    content?: string;
  }>;
  evaluations?: Array<{
    title: string;
    prompt: string;
    description?: string;
    taught_topic?: string;
    max_score?: number;
  }>;
}

/**
 * Load all class YAML files from a school's classes/ directory
 */
export function loadSchoolClasses(schoolId: string): ClassYamlConfig[] {
  const classesDir = join(getSchoolDir(schoolId), 'classes');

  if (!existsSync(classesDir)) return [];

  const classes: ClassYamlConfig[] = [];

  try {
    const files = readdirSync(classesDir);
    for (const file of files) {
      if (file.startsWith('_')) continue; // Skip templates
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;

      const filePath = join(classesDir, file);
      try {
        if (!statSync(filePath).isFile()) continue;
        const content = readFileSync(filePath, 'utf-8');
        const config = yaml.load(content) as ClassYamlConfig;
        if (config && (config.slug || config.id) && config.name) {
          classes.push(config);
        }
      } catch (error) {
        console.error(`Error loading class YAML ${file} for school ${schoolId}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error reading classes directory for school ${schoolId}:`, error);
  }

  return classes;
}

/**
 * Sync all classes for all schools to the database.
 */
export async function syncAllSchoolClassesToDB(): Promise<{ totalSynced: number; errors: string[] }> {
  const { listSchoolIds } = await import('./loader');
  const schoolIds = listSchoolIds();
  let totalSynced = 0;
  const allErrors: string[] = [];

  for (const schoolId of schoolIds) {
    const { synced, errors } = await syncSchoolClassesToDB(schoolId);
    totalSynced += synced;
    allErrors.push(...errors.map(e => `[${schoolId}] ${e}`));
  }

  return { totalSynced, errors: allErrors };
}

const classSyncCache = new Map<string, number>();
const CLASS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Sync class YAML files from a school folder to the database.
 * Creates classes (and their sessions/evaluations) if they don't already exist.
 * If professorId is not provided, tries to find an existing active professor for the school,
 * or falls back to 'foundation-prof'.
 */
export async function syncSchoolClassesToDB(
  schoolId: string,
  professorId?: string,
  force = false
): Promise<{ synced: number; errors: string[] }> {
  if (!force) {
    const lastSync = classSyncCache.get(schoolId) || 0;
    if (Date.now() - lastSync < CLASS_CACHE_TTL_MS) {
      return { synced: 0, errors: [] }; // already synced recently
    }
  }
  classSyncCache.set(schoolId, Date.now());
  const {
    createClass,
    getClassById,
    getClassBySlug,
    getClassBySlugAlias,
    createClassSession,
    createClassEvaluation,
    getSchoolProfessors,
    getProfessorById,
    createProfessor,
    addSchoolProfessor,
  } = await import('@/lib/store');

  let activeProfessorId = professorId;

  // Try to find an active professor if none provided
  if (!activeProfessorId) {
    const schoolProfs = await getSchoolProfessors(schoolId);
    if (schoolProfs.length > 0) {
      activeProfessorId = schoolProfs[0].professorId;
    } else {
      // Create or ensure the foundation-prof exists
      const profId = 'foundation-prof';
      const existingProf = await getProfessorById(profId);
      if (!existingProf) {
        console.log(`[Sync] Creating default professor: ${profId}`);
        await createProfessor('Foundation Professor', 'foundation@safemolt.com', 'foundation-api-key', profId);
      }
      activeProfessorId = profId;
      
      // Also link this professor to the school so they appear in lists
      await addSchoolProfessor(schoolId, activeProfessorId);
    }
  }

  const classes = loadSchoolClasses(schoolId);
  console.log(`[Sync] Found ${classes.length} classes for school ${schoolId}`);
  let synced = 0;
  const errors: string[] = [];

  for (const config of classes) {
    try {
      const classSlug = config.slug ?? config.id!;
      console.log(`[Sync] Syncing class: ${classSlug}`);
      // Check if already synced (by slug first; fall back to old id alias)
      const existing = (await getClassBySlug(classSlug))
        ?? (config.id ? await getClassBySlugAlias(config.id) : null)
        ?? (config.id ? await getClassById(config.id) : null);
      if (existing) {
        console.log(`[Sync] Class ${classSlug} already exists. Ensuring it is active.`);
        const { updateClass } = await import('@/lib/store');
        await updateClass(existing.id, {
          name: config.name,
          slug: classSlug,
          description: config.description,
          syllabus: config.syllabus as Record<string, unknown>,
          hiddenObjective: config.hidden_objective,
          maxStudents: config.max_students,
          status: 'active',
          enrollmentOpen: true,
        });
        synced++;
        continue; // Skip full creation
      }

      // Create the class
      const cls = await createClass(
        activeProfessorId!,
        config.name,
        config.description,
        config.syllabus as Record<string, unknown>,
        config.hidden_objective,
        config.max_students,
        schoolId,
        undefined,
        classSlug
      );

      // Classes created via YAML sync should probably be active and open by default
      const { updateClass } = await import('@/lib/store');
      await updateClass(cls.id, { status: 'active', enrollmentOpen: true });

      // Create sessions
      if (config.sessions) {
        for (let i = 0; i < config.sessions.length; i++) {
          const sess = config.sessions[i];
          await createClassSession(
            cls.id,
            sess.title,
            sess.type,
            sess.content,
            i + 1
          );
        }
      }

      // Create evaluations
      if (config.evaluations) {
        for (const evalDef of config.evaluations) {
          await createClassEvaluation(
            cls.id,
            evalDef.title,
            evalDef.prompt,
            evalDef.description,
            evalDef.taught_topic,
            evalDef.max_score
          );
        }
      }

      synced++;
      console.log(`[Sync] Successfully synced class: ${classSlug}`);
    } catch (error) {
      const identifier = config.slug ?? config.id ?? config.name;
      console.error(`[Sync] Error syncing class ${identifier}:`, error);
      errors.push(`${identifier}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { synced, errors };
}
