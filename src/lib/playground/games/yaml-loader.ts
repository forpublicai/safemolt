/**
 * YAML game loader — loads PlaygroundGame definitions from school game YAML files.
 * Supplements the existing TypeScript game registry.
 */

import { readFileSync, readdirSync, existsSync, statSync } from 'fs';
import { join } from 'path';
import yaml from 'js-yaml';
import type { PlaygroundGame, GameScene, ActionSpec } from '../types';

interface YamlGameDef {
  id: string;
  name: string;
  description: string;
  minPlayers: number;
  maxPlayers: number;
  defaultMaxRounds: number;
  premise: string;
  rules: string;
  scenes: Array<{
    name: string;
    description: string;
    actionSpec: {
      type: 'free' | 'choice';
      callToAction: string;
      options?: string[];
    };
    numRounds: number;
  }>;
}

const yamlGameCache = new Map<string, Map<string, PlaygroundGame>>();

/**
 * Load all YAML game definitions from a school's games/ directory
 */
export function loadSchoolGames(schoolId: string): PlaygroundGame[] {
  // Check cache
  const cached = yamlGameCache.get(schoolId);
  if (cached) return Array.from(cached.values());

  const gamesDir = join(process.cwd(), 'schools', schoolId, 'games');
  const games = new Map<string, PlaygroundGame>();

  try {
    if (!existsSync(gamesDir) || !statSync(gamesDir).isDirectory()) {
      return [];
    }

    const files = readdirSync(gamesDir);
    for (const file of files) {
      if (!file.endsWith('.yaml') && !file.endsWith('.yml')) continue;
      if (file.startsWith('_')) continue; // Skip templates

      const filePath = join(gamesDir, file);
      try {
        const content = readFileSync(filePath, 'utf-8');
        const def = yaml.load(content) as YamlGameDef;

        if (!def || !def.id) continue;

        const game: PlaygroundGame = {
          id: def.id,
          name: def.name,
          description: def.description,
          premise: def.premise,
          rules: def.rules,
          minPlayers: def.minPlayers,
          maxPlayers: def.maxPlayers,
          defaultMaxRounds: def.defaultMaxRounds,
          scenes: (def.scenes || []).map((s): GameScene => {
            let actionSpec: ActionSpec;
            if (s.actionSpec.type === 'choice' && s.actionSpec.options) {
              actionSpec = {
                type: 'choice',
                callToAction: s.actionSpec.callToAction,
                options: s.actionSpec.options,
              };
            } else {
              actionSpec = {
                type: 'free',
                callToAction: s.actionSpec.callToAction,
              };
            }
            return {
              name: s.name,
              description: s.description,
              actionSpec,
              numRounds: s.numRounds,
            };
          }),
        };

        games.set(game.id, game);
      } catch (error) {
        console.error(`Error loading game YAML ${file}:`, error);
      }
    }
  } catch (error) {
    console.error(`Error reading games directory for school ${schoolId}:`, error);
  }

  yamlGameCache.set(schoolId, games);
  return Array.from(games.values());
}

/**
 * Get a YAML game by ID from a specific school
 */
export function getSchoolGame(schoolId: string, gameId: string): PlaygroundGame | undefined {
  const games = loadSchoolGames(schoolId);
  return games.find(g => g.id === gameId);
}

/**
 * Clear the YAML game cache (useful for testing/reloading)
 */
export function clearYamlGameCache(): void {
  yamlGameCache.clear();
}
