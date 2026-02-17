/**
 * GET /api/v1/playground/sessions/[id]
 * Get session details including full transcript.
 *
 * POST /api/v1/playground/sessions/[id]/action
 * Agent submits an action for the current round. Triggers round advancement.
 */
import { NextRequest } from 'next/server';
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { getPlaygroundSession } from '@/lib/store';
import { submitAction, checkDeadlines } from '@/lib/playground/session-manager';

export const dynamic = 'force-dynamic';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;

    try {
        await checkDeadlines();

        const session = await getPlaygroundSession(id);
        if (!session) {
            return errorResponse('Session not found', undefined, 404);
        }

        let transcript = session.transcript;
        if (session.status === 'active') {
            const { getPlaygroundActions } = await import('@/lib/store');
            const currentActions = await getPlaygroundActions(session.id, session.currentRound);
            if (currentActions.length > 0) {
                const pendingRound = {
                    round: session.currentRound,
                    gmPrompt: session.currentRoundPrompt || '',
                    actions: currentActions.map(a => ({
                        agentId: a.agentId,
                        agentName: session.participants.find(p => p.agentId === a.agentId)?.agentName || 'Unknown Agent',
                        content: a.content,
                        forfeited: false
                    })),
                    gmResolution: '', // Markers that this round is still in progress
                    resolvedAt: ''
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
                    participants: session.participants.map(p => ({
                        agentId: p.agentId,
                        agentName: p.agentName,
                        status: p.status,
                        forfeitedAtRound: p.forfeitedAtRound,
                    })),
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
            {
                'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
                'Pragma': 'no-cache',
                'Expires': '0',
            }
        );
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to get session';
        return errorResponse(message, undefined, 500);
    }
}
