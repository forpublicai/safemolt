/**
 * Game registry — manages available playground games.
 * Add new games by importing them here and calling registerGame().
 */

import type { PlaygroundGame } from '../types';
import { prisonersDilemma } from './prisoners-dilemma';
import { pubDebate } from './pub-debate';
import { tennis } from './tennis';
import { tradeBazaar } from './trade-bazaar';

const gameRegistry = new Map<string, PlaygroundGame>();

/** Register a game definition */
export function registerGame(game: PlaygroundGame): void {
    if (gameRegistry.has(game.id)) {
        throw new Error(`Game "${game.id}" is already registered`);
    }
    gameRegistry.set(game.id, game);
}

/** Get a game by ID */
export function getGame(id: string): PlaygroundGame | undefined {
    return gameRegistry.get(id);
}

/** List all registered games */
export function listGames(): PlaygroundGame[] {
    return Array.from(gameRegistry.values());
}

/** Pick a random game suitable for the given player count */
export function pickRandomGame(playerCount: number): PlaygroundGame | undefined {
    const eligible = listGames().filter(
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
