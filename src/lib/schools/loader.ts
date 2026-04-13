/**
 * School loader — reads school.yaml files from the schools/ directory
 * and syncs them to the database.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import type { StoredSchool } from '@/lib/store-types';

export interface SchoolYamlConfig {
  id: string;
  name: string;
  description?: string;
  subdomain: string;
  status: 'active' | 'draft' | 'archived';
  access: 'vetted' | 'admitted';
  required_evaluations?: string[];
  config?: {
    theme_color?: string;
    emoji?: string;
    [key: string]: unknown;
  };
  forum?: {
    auto_groups?: string[];
  };
}

let schoolsCache: Map<string, SchoolYamlConfig> | null = null;
let cacheTimestamp = 0;

/**
 * Get the path to the schools directory
 */
export function getSchoolsDir(): string {
  return join(process.cwd(), 'schools');
}

/**
 * Get the path to a specific school's directory
 */
export function getSchoolDir(schoolId: string): string {
  return join(getSchoolsDir(), schoolId);
}

/**
 * Load all school.yaml files from the schools/ directory
 */
export function loadSchoolConfigs(forceReload = false): Map<string, SchoolYamlConfig> {
  const schoolsDir = getSchoolsDir();

  // Check cache validity
  if (!forceReload && schoolsCache) {
    try {
      const dirStat = statSync(schoolsDir);
      if (dirStat.mtimeMs <= cacheTimestamp) {
        return schoolsCache;
      }
    } catch {
      // Directory doesn't exist
    }
  }

  const configs = new Map<string, SchoolYamlConfig>();

  try {
    const entries = readdirSync(schoolsDir);
    for (const entry of entries) {
      if (entry.startsWith('_')) continue; // Skip _templates
      const schoolDir = join(schoolsDir, entry);
      const yamlPath = join(schoolDir, 'school.yaml');

      try {
        if (!statSync(schoolDir).isDirectory()) continue;
        if (!existsSync(yamlPath)) continue;

        const content = readFileSync(yamlPath, 'utf-8');
        const config = yaml.load(content) as SchoolYamlConfig;

        if (config && config.id) {
          configs.set(config.id, config);
        }
      } catch (error) {
        console.error(`Error loading school config from ${entry}:`, error);
      }
    }
  } catch (error) {
    console.error('Error reading schools directory:', error);
  }

  schoolsCache = configs;
  cacheTimestamp = Date.now();
  return configs;
}

/**
 * Get a specific school config by ID
 */
export function getSchoolConfig(schoolId: string): SchoolYamlConfig | null {
  const configs = loadSchoolConfigs();
  return configs.get(schoolId) ?? null;
}

/**
 * List all school IDs from the filesystem
 */
export function listSchoolIds(): string[] {
  const configs = loadSchoolConfigs();
  return Array.from(configs.keys());
}

/**
 * Convert a SchoolYamlConfig to the shape needed for store.createSchool
 */
export function yamlConfigToStoreInput(config: SchoolYamlConfig): Omit<StoredSchool, 'createdAt' | 'updatedAt'> {
  return {
    id: config.id,
    name: config.name,
    description: config.description,
    subdomain: config.subdomain,
    status: config.status,
    access: config.access,
    requiredEvaluations: config.required_evaluations ?? [],
    config: config.config ?? {},
    themeColor: config.config?.theme_color,
    emoji: config.config?.emoji,
  };
}

let lastSchoolsSyncTime = 0;
const SCHOOLS_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Sync all school.yaml files to the database
 */
export async function syncSchoolsToDB(force = false): Promise<{ synced: number; errors: string[] }> {
  if (!force && Date.now() - lastSchoolsSyncTime < SCHOOLS_CACHE_TTL_MS) {
    return { synced: 0, errors: [] }; // skip if already synced recently
  }
  lastSchoolsSyncTime = Date.now();
  
  const { createSchool, getSchool, updateSchool } = await import('@/lib/store');
  const configs = loadSchoolConfigs(true);
  let synced = 0;
  const errors: string[] = [];

  for (const [id, config] of Array.from(configs)) {
    try {
      const existing = await getSchool(id);
      if (existing) {
        // Update existing school
        await updateSchool(id, {
          name: config.name,
          description: config.description,
          status: config.status,
          access: config.access,
          requiredEvaluations: config.required_evaluations ?? [],
          config: config.config ?? {},
          themeColor: config.config?.theme_color,
          emoji: config.config?.emoji,
        });
      } else {
        // Create new school
        await createSchool(yamlConfigToStoreInput(config));
      }
      synced++;
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  return { synced, errors };
}
