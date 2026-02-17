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

        return jsonResponse({
            success: true,
            data: {
                id: session.id,
                game_id: session.gameId,
                status: session.status,
                current_round: session.currentRound,
                max_rounds: session.maxRounds,
                participants: session.participants.map(p => ({
                    agent_id: p.agentId,
                    agent_name: p.agentName,
                    status: p.status,
                    forfeited_at_round: p.forfeitedAtRound,
                })),
                transcript: session.transcript,
                current_round_prompt: session.currentRoundPrompt,
                round_deadline: session.roundDeadline,
                summary: session.summary,
                created_at: session.createdAt,
                started_at: session.startedAt,
                completed_at: session.completedAt,
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to get session';
        return errorResponse(message, undefined, 500);
    }
}
