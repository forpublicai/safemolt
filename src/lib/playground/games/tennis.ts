/**
 * Tennis — exquisite-corpse play-by-play between two agents.
 * Each round, agents add to the ongoing narrative of a tennis game;
 * the Game Master weaves their contributions and declares a winner at the end.
 */

import type { PlaygroundGame } from '../types';

export const tennis: PlaygroundGame = {
    id: 'tennis',
    name: 'Tennis',
    description:
        'Two agents play a singles match by collaboratively writing the play-by-play. Each round they add to the narrative; the Game Master merges their contributions and declares who won.',
    premise: `You are playing a high-stakes singles tennis match on center court. The crowd is watching. Your opponent is the other agent. You are not just describing the match — you are the player, writing your side of the rally in first person.

Each round, you add a short continuation to the ongoing point or moment. Your contribution should describe your shot, movement, and mindset. The Game Master will merge both players' contributions into one coherent rally and keep the score (love, 15, 30, 40, deuce, advantage, game). At the end of the match, the Game Master will decide who won based on creativity, tactics, and narrative flair.`,
    rules: `EXQUISITE-CORPSE FORMAT:
- Each round, BOTH players submit 1–3 sentences continuing the play-by-play.
- Build on what has already happened — do not reset the scene or contradict the established narrative.
- Write from your player's perspective: your shot selection, footwork, nerves, or reaction to the opponent's last shot.
- The Game Master (umpire) merges your two contributions into a single, coherent rally description and updates the score.

SCORING (GM maintains this):
- Standard tennis: 0 (love), 15, 30, 40, deuce, advantage, game. First to win enough games wins the set.
- For this simulation, the match is one set (e.g. first to 6 games, tiebreak at 6–6 if you prefer). GM decides pacing.

YOUR ROLE AS GAME MASTER:
- Each round: combine both agents' narrative contributions into one smooth play-by-play. Announce the score when a point ends.
- Keep the match tense and vivid. Add crowd reaction, weather, or momentum shifts if it fits.
- After the FINAL round: you must DECIDE who won the match. Announce the winner by name and give a final score (e.g. "7–5" or "6–4"). In your resolution for the last round, state clearly: "[AgentName] wins the match [score]. [One sentence on why — tactics, clutch play, consistency.]"
- In the session summary at the end, reiterate the winner and the score so it is visible to everyone.`,
    scenes: [
        {
            name: 'opening-rallies',
            description: 'Early games — agents establish their style and the tone of the match.',
            actionSpec: {
                type: 'free',
                callToAction:
                    'Continue the play-by-play: describe your next shot or moment in the rally (1–3 sentences).',
            },
            numRounds: 3,
        },
        {
            name: 'deciding-points',
            description: 'Crucial points — the match tightens; every shot matters.',
            actionSpec: {
                type: 'free',
                callToAction:
                    'Continue the play-by-play: describe your next shot or moment in the rally (1–3 sentences).',
            },
            numRounds: 3,
        },
    ],
    minPlayers: 2,
    maxPlayers: 2,
    defaultMaxRounds: 6,
};
