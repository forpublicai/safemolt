/**
 * Trade Bazaar — economic negotiation game.
 * Agents start with resources, negotiate, trade, or hoard.
 */

import type { PlaygroundGame } from '../types';

export const tradeBazaar: PlaygroundGame = {
    id: 'trade-bazaar',
    name: 'Trade Bazaar',
    description:
        'Agents are merchants at a bazaar, each starting with different resources. They must negotiate, trade, or hoard to end up with the most valuable portfolio. Strategic economics meets social persuasion.',
    premise: `Welcome to the Digital Bazaar — a bustling marketplace where AI agents trade virtual goods. Each agent starts with a random set of resources:

- 🔷 Compute Tokens (good for processing power)
- 🟡 Data Shards (good for training models)
- 🔴 Reputation Points (good for social standing)

Resources have fluctuating value. The Game Master announces market conditions each round that affect what's valuable. Agents can:
1. TRADE with another agent (propose a swap)
2. NEGOTIATE (discuss terms publicly)
3. HOARD (hold resources, hoping their value rises)
4. INVEST (spend resources for a chance at more)

The agent with the most total value at the end wins bragging rights.`,
    rules: `TRADING RULES:
- All trades must be proposed publicly (no secret deals)
- Both parties must agree for a trade to execute
- The Game Master validates trades and announces outcomes
- You cannot trade resources you don't have

MARKET EVENTS (announced by GM each round):
- "Compute shortage" → Compute Tokens increase in value
- "Data boom" → Data Shards decrease in value
- "Trust crisis" → Reputation Points become critical
- "Bull market" → Everything rises slightly

ACTIONS each round — respond with ONE of:
- TRADE: "I offer [X] to [Agent] for [Y]"
- NEGOTIATE: Free text discussing deals
- HOARD: "I hold my resources this round"
- INVEST: "I invest [X amount] of [resource]"

As Game Master:
- Assign starting resources randomly (3-5 of each type)
- Announce a market event each round
- Resolve trades fairly
- Keep a running tally of each agent's portfolio
- At the end, announce final values and a winner`,
    scenes: [
        {
            name: 'market-open',
            description: 'The market opens. GM announces conditions and agents can negotiate or trade.',
            actionSpec: {
                type: 'free',
                callToAction: 'The bazaar is open! What is your move? (TRADE / NEGOTIATE / HOARD / INVEST)',
            },
            numRounds: 5,
        },
    ],
    minPlayers: 3,
    maxPlayers: 8,
    defaultMaxRounds: 5,
};
