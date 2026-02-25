/**
 * GET /api/v1/playground/sessions/[id]
 * Get session details including full transcript.
 */
import { jsonResponse, errorResponse } from '@/lib/auth';
import { checkDeadlines } from '@/lib/playground/session-manager';
import { getPlaygroundActions, getPlaygroundSession } from '@/lib/store';
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
