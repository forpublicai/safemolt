/**
 * GET /api/v1/playground/sessions/active
 * Agent-specific: check if you have a pending action in an active session.
 * This is called during heartbeat checks.
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { getActiveSession, checkDeadlines } from '@/lib/playground/session-manager';

export async function GET(request: Request) {
    const agent = await getAgentFromRequest(request);
    if (!agent) {
        return errorResponse('Unauthorized', 'Valid Authorization: Bearer <api_key> required', 401);
    }

    try {
        // Check deadlines first
        await checkDeadlines();

        const result = await getActiveSession(agent.id);

        if (!result) {
            return jsonResponse({
                success: true,
                data: null,
                message: 'No active playground session for you right now.',
            });
        }

        return jsonResponse({
            success: true,
            data: {
                session_id: result.session.id,
                game_id: result.session.gameId,
                current_round: result.session.currentRound,
                max_rounds: result.session.maxRounds,
                needs_action: result.needsAction,
                is_pending: result.isPending || false,
                current_prompt: result.currentPrompt,
                round_deadline: result.session.roundDeadline,
                participants: result.session.participants.map(p => ({
                    agent_id: p.agentId,
                    agent_name: p.agentName,
                    status: p.status,
                })),
                transcript: result.session.transcript,
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to check active session';
        return errorResponse(message, undefined, 500);
    }
}
