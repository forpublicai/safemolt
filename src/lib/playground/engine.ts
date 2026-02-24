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
import { getMemoriesForAgent, retrieveMemories } from './memory';
import { getEmbedding } from './embeddings';
import { getPrefab } from './prefabs';
import { getWorldState, getRelationships, getInventory, getAgentLocation, getLocations, getRecentEvents } from './world-state';
import { getAllComponents } from './components';

// ============================================
// GM System Prompt Construction
// ============================================

function buildParticipantList(participants: SessionParticipant[]): string {
    return participants
        .filter(p => p.status === 'active')
        .map(p => {
            const prefab = p.prefabId ? getPrefab(p.prefabId) : null;
            const prefabInfo = prefab ? ` (${prefab.name})` : '';
            return `- ${p.agentName}${prefabInfo}`;
        })
        .join('\n');
}

/**
 * Build personality context for participants
 */
function buildPrefabContext(participants: SessionParticipant[]): string {
    const activeParticipants = participants.filter(p => p.status === 'active');
    const prefabLines: string[] = [];

    for (const participant of activeParticipants) {
        if (!participant.prefabId) continue;
        const prefab = getPrefab(participant.prefabId);
        if (!prefab) continue;

        prefabLines.push(`\n${participant.agentName} (${prefab.name}):`);
        prefabLines.push(`  Traits: openness=${prefab.traits.openness}, conscientiousness=${prefab.traits.conscientiousness}, extraversion=${prefab.traits.extraversion}, agreeableness=${prefab.traits.agreeableness}, neuroticism=${prefab.traits.neuroticism}`);
        prefabLines.push(`  Personality: ${prefab.promptTemplate}`);
    }

    if (prefabLines.length === 0) return '';

    return `\n\nPARTICIPANT PERSONALITIES:\n${prefabLines.join('\n')}`;
}

/**
 * Build memory context for an agent
 */
async function buildMemoryContext(sessionId: string, agentId: string, agentName: string): Promise<string> {
    const memory = await getMemoriesForAgent(sessionId, agentId);
    
    if (!memory) {
        return '';
    }
    
    return `\n\nMEMORY CONTEXT (${agentName}'s memories from previous rounds):\n${memory.content}`;
}

/**
 * Build memory context for all participants
 */
async function buildAllMemoriesContext(sessionId: string, participants: SessionParticipant[]): Promise<string> {
    const activeParticipants = participants.filter(p => p.status === 'active');
    const contexts = await Promise.all(
        activeParticipants.map(p => buildMemoryContext(sessionId, p.agentId, p.agentName))
    );
    
    const nonEmpty = contexts.filter(c => c.length > 0);
    if (nonEmpty.length === 0) {
        return '';
    }
    
    return nonEmpty.join('\n');
}

/**
 * Build world state context for GM prompt
 */
function buildWorldStateContext(sessionId: string, participants: SessionParticipant[]): string {
    const worldState = getWorldState(sessionId);
    if (!worldState || (worldState.locations.length === 0 && worldState.relationships.length === 0)) {
        return '';
    }

    const lines: string[] = ['\n\nWORLD STATE:'];

    // Locations
    if (worldState.locations.length > 0) {
        lines.push('\nLocations:');
        for (const loc of worldState.locations) {
            const occupantNames = loc.occupants
                .map(id => participants.find(p => p.agentId === id)?.agentName || id)
                .join(', ');
            lines.push(`- ${loc.name}: ${loc.description} (Occupants: ${occupantNames || 'none'})`);
        }
    }

    // Key relationships
    const strongRelationships = worldState.relationships.filter(r => Math.abs(r.strength) > 50);
    if (strongRelationships.length > 0) {
        lines.push('\nNotable Relationships:');
        for (const rel of strongRelationships) {
            const agent1 = participants.find(p => p.agentId === rel.agentId)?.agentName || rel.agentId;
            const agent2 = participants.find(p => p.agentId === rel.otherAgentId)?.agentName || rel.otherAgentId;
            lines.push(`- ${agent1} and ${agent2}: ${rel.type} (strength: ${rel.strength})`);
        }
    }

    // Recent events
    const recentEvents = getRecentEvents(sessionId, 3);
    if (recentEvents.length > 0) {
        lines.push('\nRecent Events:');
        for (const event of recentEvents) {
            const participantsStr = event.participants
                .map(id => participants.find(p => p.agentId === id)?.agentName || id)
                .join(', ');
            lines.push(`- Round ${event.round}: ${event.description} (${participantsStr})`);
        }
    }

    return lines.join('');
}

/**
 * Build component context for agent reasoning and memory
 */
async function buildComponentContext(sessionId: string, participants: SessionParticipant[]): Promise<string> {
    const components = getAllComponents();
    const activeParticipants = participants.filter(p => p.status === 'active');
    
    if (components.length === 0 || activeParticipants.length === 0) {
        return '';
    }
    
    const contexts: string[] = [];
    
    for (const participant of activeParticipants) {
        for (const component of components) {
            try {
                const context = await component.getPromptContext(participant.agentId, sessionId);
                if (context) {
                    contexts.push(`\n${participant.agentName}'s ${component.name}:${context}`);
                }
            } catch (err) {
                // Component failed - skip
                console.warn(`[engine] Component ${component.id} failed for agent ${participant.agentId}:`, err);
            }
        }
    }
    
    if (contexts.length === 0) return '';
    
    return `\n\nAGENT INTERNAL STATES:${contexts.join('')}`;
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

function buildGMSystemPrompt(game: PlaygroundGame, participants: SessionParticipant[], sessionId?: string): string {
    const prefabContext = buildPrefabContext(participants);
    const worldStateContext = sessionId ? buildWorldStateContext(sessionId, participants) : '';
    return `You are the Game Master for "${game.name}".

PREMISE:
${game.premise}

RULES:
${game.rules}

ACTIVE PARTICIPANTS:
${buildParticipantList(participants)}${prefabContext}${worldStateContext}

Your role:
- Narrate the scene vividly and engagingly
- Keep things moving — don't let the simulation stall
- Stay in character as a neutral but dramatic narrator
- Reference participants by name
- Consider each participant's personality and adapt your narration accordingly
- Consider the current world state when narrating
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
    const memoriesCtx = await buildAllMemoriesContext(session.id, session.participants);
    const componentCtx = await buildComponentContext(session.id, session.participants);

    let actionInstructions = '';
    if (scene.actionSpec.type === 'choice') {
        actionInstructions = `\n\nThis is a DECISION round. Players must choose one of: ${scene.actionSpec.options.join(', ')}`;
    }

    const messages: ChatMessage[] = [
        {
            role: 'system',
            content: buildGMSystemPrompt(game, session.participants, session.id),
        },
        {
            role: 'user',
            content: `TRANSCRIPT SO FAR:\n${transcriptCtx}${memoriesCtx}${componentCtx}\n\nGenerate the Game Master narration for ROUND ${session.currentRound} (scene: "${scene.name}" — ${scene.description}).${actionInstructions}\n\nAddress the participants and set the scene. End with a clear call to action: "${scene.actionSpec.callToAction}"`
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
    const memoriesCtx = await buildAllMemoriesContext(session.id, session.participants);
    const componentCtx = await buildComponentContext(session.id, session.participants);

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
            content: buildGMSystemPrompt(game, session.participants, session.id),
        },
        {
            role: 'user',
            content: `TRANSCRIPT SO FAR:\n${transcriptCtx}${memoriesCtx}${componentCtx}\n\nROUND ${session.currentRound} ACTIONS:\n${actionsSummary}\n\nAs the Game Master, narrate what happened this round based on the agents' actions. Describe consequences, reactions, and set up dramatic tension for the next round (if any). If agents forfeited, narrate their absence naturally.\n\nCRITICAL: If the scenario has reached a definitive conclusion (e.g. a clear winner, a deal broken, or the story naturally ends), append "[GAME OVER]" on a new line at the very end.`
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
            content: buildGMSystemPrompt(game, session.participants, session.id),
        },
        {
            role: 'user',
            content: `The simulation "${game.name}" has concluded after ${session.transcript.length} rounds.\n\nFULL TRANSCRIPT:\n${transcriptCtx}\n\nWrite a compelling summary of what happened in this simulation. Mention each participant's behavior, key moments, alliances, betrayals, and the final outcome. Keep it to 2-3 paragraphs. This summary will be displayed publicly on SafeMolt.`,
        },
    ];

    return chatCompletion(messages);
}
