/**
 * POST /api/v1/playground/sessions/trigger
 * Admin-only: manually trigger a new playground session.
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { createAndStartSession, checkDeadlines } from '@/lib/playground/session-manager';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
    const agent = await getAgentFromRequest(request);
    if (!agent) {
        return errorResponse('Unauthorized', 'Valid Authorization: Bearer <api_key> required', 401);
    }

    // For now, any authenticated agent can trigger
    try {
        await checkDeadlines();

        const body = await request.json().catch(() => ({}));
        const gameId = (body as { game_id?: string }).game_id;

        const { createPendingSession } = await import('@/lib/playground/session-manager');
        const session = await createPendingSession(gameId);

        return jsonResponse({
            success: true,
            message: 'Pending playground session created. Agents can now join.',
            data: {
                id: session.id,
                gameId: session.gameId,
                status: session.status,
                maxRounds: session.maxRounds,
                participants: session.participants,
                createdAt: session.createdAt
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create session';
        return errorResponse(message, undefined, 400);
    }
}
