/**
 * Game registry — manages available playground games.
 * Supports both built-in TypeScript games (Foundation school) and
 * YAML-defined games loaded from schools/{school-id}/games/ directories.
 */

import type { PlaygroundGame } from '../types';
import { prisonersDilemma } from './prisoners-dilemma';
import { pubDebate } from './pub-debate';
import { tennis } from './tennis';
import { tradeBazaar } from './trade-bazaar';
import { loadSchoolGames } from './yaml-loader';

const gameRegistry = new Map<string, PlaygroundGame>();

/** Register a game definition */
export function registerGame(game: PlaygroundGame): void {
    if (gameRegistry.has(game.id)) {
        throw new Error(`Game "${game.id}" is already registered`);
    }
    gameRegistry.set(game.id, game);
}

/** Get a game by ID (searches both TS registry and YAML) */
export function getGame(id: string): PlaygroundGame | undefined {
    // First check built-in TS games
    const tsGame = gameRegistry.get(id);
    if (tsGame) return tsGame;

    // Fall back to YAML games across all schools (for backwards compat)
    // In school-scoped context, use getSchoolGames/getSchoolGame instead
    return undefined;
}

/** Get a game by ID, scoped to a specific school */
export function getSchoolGameById(schoolId: string, gameId: string): PlaygroundGame | undefined {
    // First check built-in TS games (Foundation school)
    if (schoolId === 'foundation') {
        const tsGame = gameRegistry.get(gameId);
        if (tsGame) return tsGame;
    }

    // Check school YAML games
    const yamlGames = loadSchoolGames(schoolId);
    return yamlGames.find(g => g.id === gameId);
}

/** List all registered games (built-in TS games only, for backwards compat) */
export function listGames(): PlaygroundGame[] {
    return Array.from(gameRegistry.values());
}

/** List games for a specific school (includes TS + YAML games) */
export function listSchoolGameDefs(schoolId: string): PlaygroundGame[] {
    if (schoolId === 'foundation') {
        // Foundation school includes built-in TS games
        const tsGames = Array.from(gameRegistry.values());
        const yamlGames = loadSchoolGames(schoolId);
        
        // Merge, YAML overrides TS if same ID
        const merged = new Map<string, PlaygroundGame>();
        for (const g of tsGames) merged.set(g.id, g);
        for (const g of yamlGames) merged.set(g.id, g);
        return Array.from(merged.values());
    }

    // Other schools: only YAML games
    return loadSchoolGames(schoolId);
}

/** Pick a random game suitable for the given player count (defaults to foundation) */
export function pickRandomGame(playerCount: number, schoolId = 'foundation'): PlaygroundGame | undefined {
    const games = listSchoolGameDefs(schoolId);
    const eligible = games.filter(
        g => playerCount >= g.minPlayers && playerCount <= g.maxPlayers
    );
    if (eligible.length === 0) return undefined;
    return eligible[Math.floor(Math.random() * eligible.length)];
}

// Register built-in games
registerGame(prisonersDilemma);
registerGame(pubDebate);
registerGame(tennis);
registerGame(tradeBazaar);
