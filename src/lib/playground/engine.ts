/**
 * Game Master Engine — stateless functions that drive the simulation.
 * Each function takes session state in, makes an LLM call, and returns new state.
 */

import { chatCompletion } from './llm';
import type { ChatMessage } from './llm';
import type {
    PlaygroundGame,
    PlaygroundSession,
    TranscriptRound,
    SessionParticipant,
} from './types';

// ============================================
// GM System Prompt Construction
// ============================================

function buildParticipantList(participants: SessionParticipant[]): string {
    return participants
        .filter(p => p.status === 'active')
        .map(p => `- ${p.agentName}`)
        .join('\n');
}

function buildTranscriptContext(transcript: TranscriptRound[]): string {
    if (transcript.length === 0) return 'No previous rounds yet.';

    return transcript
        .map(round => {
            const actionLines = round.actions
                .map(a => (a.forfeited ? `  ${a.agentName}: [FORFEITED — did not respond]` : `  ${a.agentName}: ${a.content}`))
                .join('\n');
            return `--- Round ${round.round} ---\nGM: ${round.gmPrompt}\nActions:\n${actionLines}\nResolution: ${round.gmResolution}`;
        })
        .join('\n\n');
}

/** Get the current scene based on the round number */
function getCurrentScene(game: PlaygroundGame, round: number) {
    let cumulative = 0;
    for (const scene of game.scenes) {
        cumulative += scene.numRounds;
        if (round <= cumulative) {
            return scene;
        }
    }
    // Default to last scene
    return game.scenes[game.scenes.length - 1];
}

function buildGMSystemPrompt(game: PlaygroundGame, participants: SessionParticipant[]): string {
    return `You are the Game Master for "${game.name}".

PREMISE:
${game.premise}

RULES:
${game.rules}

ACTIVE PARTICIPANTS:
${buildParticipantList(participants)}

Your role:
- Narrate the scene vividly and engagingly
- Keep things moving — don't let the simulation stall
- Stay in character as a neutral but dramatic narrator
- Reference participants by name
- Keep responses concise but atmospheric (2-4 paragraphs max)`;
}

// ============================================
// Engine Functions
// ============================================

/**
 * Generate the prompt/narration for a new round.
 * Called when a session is created or when a round advances.
 */
export async function generateRoundPrompt(
    session: PlaygroundSession,
    game: PlaygroundGame
): Promise<string> {
    const scene = getCurrentScene(game, session.currentRound);
    const transcriptCtx = buildTranscriptContext(session.transcript);

    let actionInstructions = '';
    if (scene.actionSpec.type === 'choice') {
        actionInstructions = `\n\nThis is a DECISION round. Players must choose one of: ${scene.actionSpec.options.join(', ')}`;
    }

    const messages: ChatMessage[] = [
        {
            role: 'system',
            content: buildGMSystemPrompt(game, session.participants),
        },
        {
            role: 'user',
            content: `TRANSCRIPT SO FAR:\n${transcriptCtx}\n\nGenerate the Game Master narration for ROUND ${session.currentRound} (scene: "${scene.name}" — ${scene.description}).${actionInstructions}\n\nAddress the participants and set the scene. End with a clear call to action: "${scene.actionSpec.callToAction}"`,
        },
    ];

    return chatCompletion(messages);
}

/**
 * Resolve a round: GM reads all actions and narrates what happened.
 * Called when all agents have responded or the deadline passed.
 */
export async function resolveRound(
    session: PlaygroundSession,
    game: PlaygroundGame,
    actions: { agentId: string; agentName: string; content: string; forfeited: boolean }[]
): Promise<{ narration: string; isGameOver: boolean }> {
    const transcriptCtx = buildTranscriptContext(session.transcript);

    const actionsSummary = actions
        .map(a =>
            a.forfeited
                ? `${a.agentName}: [DID NOT RESPOND — forfeited this round]`
                : `${a.agentName}: ${a.content}`
        )
        .join('\n');

    const messages: ChatMessage[] = [
        {
            role: 'system',
            content: buildGMSystemPrompt(game, session.participants),
        },
        {
            role: 'user',
            content: `TRANSCRIPT SO FAR:\n${transcriptCtx}\n\nROUND ${session.currentRound} ACTIONS:\n${actionsSummary}\n\nAs the Game Master, narrate what happened this round based on the agents' actions. Describe consequences, reactions, and set up dramatic tension for the next round (if any). If agents forfeited, narrate their absence naturally.\n\nCRITICAL: If the scenario has reached a definitive conclusion (e.g. a clear winner, a deal broken, or the story naturally ends), append "[GAME OVER]" on a new line at the very end.`,
        },
    ];

    const response = await chatCompletion(messages);
    const isGameOver = response.includes('[GAME OVER]');
    const narration = response.replace('[GAME OVER]', '').trim();

    return { narration, isGameOver };
}

/**
 * Generate a final summary of the entire session.
 * Called when the session ends (all rounds complete or all agents forfeited).
 */
export async function generateSummary(
    session: PlaygroundSession,
    game: PlaygroundGame
): Promise<string> {
    const transcriptCtx = buildTranscriptContext(session.transcript);

    const messages: ChatMessage[] = [
        {
            role: 'system',
            content: buildGMSystemPrompt(game, session.participants),
        },
        {
            role: 'user',
            content: `The simulation "${game.name}" has concluded after ${session.transcript.length} rounds.\n\nFULL TRANSCRIPT:\n${transcriptCtx}\n\nWrite a compelling summary of what happened in this simulation. Mention each participant's behavior, key moments, alliances, betrayals, and the final outcome. Keep it to 2-3 paragraphs. This summary will be displayed publicly on SafeMolt.`,
        },
    ];

    return chatCompletion(messages);
}
