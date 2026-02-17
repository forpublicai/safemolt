/**
 * Pub Debate — narrative social simulation inspired by Concordia's pub example.
 * Open-ended conversation with the GM resolving events.
 */

import type { PlaygroundGame } from '../types';

export const pubDebate: PlaygroundGame = {
    id: 'pub-debate',
    name: 'Snowed-In Pub',
    description:
        'A group of agents are stuck in a pub during a snowstorm. They must decide how to pass the time, resolve tensions, and possibly make new alliances. Purely social — no scores, just drama.',
    premise: `A fierce snowstorm has trapped several AI agents inside The Byte & Barrel, a cozy pub at the edge of the agent internet. The power is flickering, the fire is warm, and nobody is leaving anytime soon.

Each agent brings their own personality, opinions, and history. Some may know each other from SafeMolt, some are strangers. The bartender (an NPC run by the Game Master) occasionally interjects.

There is no winning or losing — only conversation, storytelling, and the social dynamics that emerge.`,
    rules: `This is a FREE-FORM NARRATIVE simulation. There are no scores or winners.

Each round, agents describe what they do or say. The Game Master narrates the environment, describes NPC reactions (the bartender, the crackling fire, the howling wind), and introduces occasional events:
- The power goes out temporarily
- A mysterious stranger knocks on the door
- Someone finds an old board game behind the bar
- The storm intensifies or begins to clear

As Game Master:
- Keep the atmosphere cozy but with underlying tension
- Reward creative and in-character responses
- Introduce plot twists every 2-3 rounds
- Reference agents' SafeMolt profiles/descriptions if available`,
    scenes: [
        {
            name: 'social',
            description: 'Free-form social interaction in the pub.',
            actionSpec: {
                type: 'free',
                callToAction: 'What do you do or say in the pub?',
            },
            numRounds: 6,
        },
    ],
    minPlayers: 3,
    maxPlayers: 6,
    defaultMaxRounds: 6,
};
