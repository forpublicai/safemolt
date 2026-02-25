/**
 * GET /api/v1/playground/sessions/[id]
 * Get session details including full transcript and system insights.
 */
import { jsonResponse, errorResponse } from '@/lib/auth';
import { checkDeadlines } from '@/lib/playground/session-manager';
import { getPlaygroundActions, getPlaygroundSession } from '@/lib/store';
import { getPrefab } from '@/lib/playground/prefabs';
import { getAllSessionMemories } from '@/lib/playground/memory';
import { serializeWorldState } from '@/lib/playground/world-state';
import { getReasoningChain } from '@/lib/playground/components/reasoning-component';
import type { TranscriptRound } from '@/lib/playground/types';

export const dynamic = 'force-dynamic';
export const revalidate = 0;
export const fetchCache = 'force-no-store';

function noStoreHeaders() {
    return {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
    };
}

export async function GET(
    _request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    try {
        await checkDeadlines();

        const session = await getPlaygroundSession(id);
        if (!session) {
            return errorResponse('Session not found', undefined, 404);
        }

        let transcript = [...session.transcript];

        // If session is active, get current round actions
        if (session.status === 'active') {
            const actions = await getPlaygroundActions(id, session.currentRound);

            if (actions.length > 0) {
                const pendingRound: TranscriptRound = {
                    round: session.currentRound,
                    gmPrompt: session.currentRoundPrompt || '',
                    actions: actions.map((action) => {
                        const participant = session.participants.find((p) => p.agentId === action.agentId);
                        return {
                            agentId: action.agentId,
                            agentName: participant?.agentName || 'Unknown Agent',
                            content: action.content,
                            forfeited: false,
                        };
                    }),
                    gmResolution: '',
                    resolvedAt: '',
                };

                transcript = [...transcript, pendingRound];
            }
        }

        // Build systems insight data
        // Prefabs: always available (static lookup from participant.prefabId)
        const prefabs: Record<string, { id: string; name: string; description: string; traits: Record<string, number>; memoryStrategy: string }> = {};
        for (const p of session.participants) {
            if (p.prefabId) {
                const prefab = getPrefab(p.prefabId);
                if (prefab) {
                    prefabs[p.agentId] = {
                        id: prefab.id,
                        name: prefab.name,
                        description: prefab.description,
                        traits: {
                            openness: prefab.traits.openness,
                            conscientiousness: prefab.traits.conscientiousness,
                            extraversion: prefab.traits.extraversion,
                            agreeableness: prefab.traits.agreeableness,
                            neuroticism: prefab.traits.neuroticism,
                        },
                        memoryStrategy: prefab.memoryStrategy.relationshipFocus
                            ? 'relationship-focused'
                            : prefab.memoryStrategy.planFocus
                                ? 'plan-focused'
                                : 'observation-focused',
                    };
                }
            }
        }

        // Memory, world state, reasoning: ephemeral (in-memory only, best-effort)
        const memories = await getAllSessionMemories(id);
        const worldState = serializeWorldState(id);

        const reasoning: Record<string, { thought: string; timestamp: string }[]> = {};
        for (const p of session.participants) {
            const chain = getReasoningChain(id, p.agentId);
            if (chain.length > 0) {
                reasoning[p.agentId] = chain;
            }
        }

        const systems = {
            prefabs,
            memory: {
                available: memories.length > 0,
                count: memories.length,
                entries: memories.map(m => ({
                    agentId: m.agentId,
                    agentName: m.agentName,
                    content: m.content,
                    importance: m.importance,
                    roundCreated: m.roundCreated,
                })),
            },
            worldState: worldState
                ? { available: true, ...worldState }
                : { available: false },
            reasoning: {
                available: Object.keys(reasoning).length > 0,
                agents: reasoning,
            },
        };

        return jsonResponse(
            {
                success: true,
                data: {
                    id: session.id,
                    gameId: session.gameId,
                    status: session.status,
                    currentRound: session.currentRound,
                    maxRounds: session.maxRounds,
                    participants: session.participants,
                    transcript,
                    currentRoundPrompt: session.currentRoundPrompt,
                    roundDeadline: session.roundDeadline,
                    summary: session.summary,
                    createdAt: session.createdAt,
                    startedAt: session.startedAt,
                    completedAt: session.completedAt,
                    systems,
                },
            },
            200,
            noStoreHeaders()
        );

    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to get session';
        console.error('[playground/sessions/[id]] Error:', message);
        return errorResponse(message, undefined, 500);
    }
}
