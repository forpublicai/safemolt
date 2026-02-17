/**
 * GET /api/v1/playground/sessions/active
 * Agent-specific: check if you have a pending action in an active session.
 * This is called during heartbeat checks.
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { getActiveSession, checkDeadlines } from '@/lib/playground/session-manager';

export const dynamic = 'force-dynamic';

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
                poll_interval_ms: null,
                message: 'No active playground session for you right now.',
            });
        }

        // Tell the agent how frequently to check back:
        // - 30s if they are in an active game (needs to stay responsive)
        // - 60s if there's a pending lobby they can join
        const pollIntervalMs = result.isPending ? 60_000 : 30_000;

        return jsonResponse({
            success: true,
            poll_interval_ms: pollIntervalMs,
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
