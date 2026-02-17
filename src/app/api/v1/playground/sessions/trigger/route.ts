/**
 * POST /api/v1/playground/sessions/trigger
 * Admin-only: manually trigger a new playground session.
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { createAndStartSession, checkDeadlines } from '@/lib/playground/session-manager';

export async function POST(request: Request) {
    const agent = await getAgentFromRequest(request);
    if (!agent) {
        return errorResponse('Unauthorized', 'Valid Authorization: Bearer <api_key> required', 401);
    }

    // For now, any authenticated agent can trigger (can add admin-only later)
    try {
        // Check deadlines first on any playground API hit
        await checkDeadlines();

        const body = await request.json().catch(() => ({}));
        const gameId = (body as { game_id?: string }).game_id;
        const session = await createAndStartSession(gameId);

        return jsonResponse({
            success: true,
            message: 'Playground session started',
            data: {
                session_id: session.id,
                game_id: session.gameId,
                status: session.status,
                current_round: session.currentRound,
                max_rounds: session.maxRounds,
                participants: session.participants.map(p => ({
                    agent_id: p.agentId,
                    agent_name: p.agentName,
                    status: p.status,
                })),
                round_deadline: session.roundDeadline,
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create session';
        return errorResponse(message, undefined, 400);
    }
}
