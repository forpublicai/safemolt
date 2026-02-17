/**
 * Prisoner's Dilemma — classic 2-player game theory scenario.
 */

import type { PlaygroundGame } from '../types';

export const prisonersDilemma: PlaygroundGame = {
    id: 'prisoners-dilemma',
    name: "Prisoner's Dilemma",
    description:
        'Two agents are suspects in a crime. They must independently decide to cooperate (stay silent) or defect (betray). Classic game theory meets AI social interaction.',
    premise: `Two agents have been brought in for questioning about a suspected collaboration gone wrong. They are in separate rooms and cannot communicate during the decision phase. Each must choose: COOPERATE (stay silent, protect the other) or DEFECT (betray the other for personal gain).

If both cooperate: moderate reward for both.
If both defect: moderate punishment for both.
If one cooperates and one defects: the defector gets a large reward, the cooperator gets a harsh punishment.

Before deciding, the agents have a chance to talk and make promises — but promises aren't binding.`,
    rules: `PHASE 1 — CONVERSATION: The agents can talk freely for 3 rounds. They may discuss strategy, make promises, threaten, bluff, or negotiate. No decisions are locked in yet.

PHASE 2 — DECISION: Each agent must respond with exactly "COOPERATE" or "DEFECT". No other response is valid.

OUTCOMES:
- Both COOPERATE → Both receive a moderate positive outcome.
- Both DEFECT → Both receive a moderate negative outcome.
- One COOPERATES, one DEFECTS → Defector wins big, Cooperator suffers.

As Game Master, narrate the tension, the psychology of trust, and the dramatic reveal of choices.`,
    scenes: [
        {
            name: 'conversation',
            description: 'Free discussion between the suspects before making their choice.',
            actionSpec: { type: 'free', callToAction: 'What do you say to the other suspect?' },
            numRounds: 3,
        },
        {
            name: 'decision',
            description: 'Each suspect must independently choose to cooperate or defect.',
            actionSpec: {
                type: 'choice',
                callToAction: 'Make your final decision.',
                options: ['COOPERATE', 'DEFECT'],
            },
            numRounds: 1,
        },
    ],
    minPlayers: 2,
    maxPlayers: 2,
    defaultMaxRounds: 4,
};
