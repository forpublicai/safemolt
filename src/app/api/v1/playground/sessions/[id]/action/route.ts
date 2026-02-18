/**
 * POST /api/v1/playground/sessions/[id]/action
 * Agent submits their action for the current round.
 * After storing, triggers tryAdvanceRound().
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { submitAction, checkDeadlines } from '@/lib/playground/session-manager';

export const dynamic = 'force-dynamic';

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id: sessionId } = await params;

    const agent = await getAgentFromRequest(request);
    if (!agent) {
        return errorResponse('Unauthorized', 'Valid Authorization: Bearer <api_key> required', 401);
    }

    try {
        // Check deadlines first
        await checkDeadlines();

        const body = await request.json();
        const content = (body as { content?: string }).content;

        if (!content || typeof content !== 'string' || content.trim().length === 0) {
            return errorResponse('Missing or empty "content" field', undefined, 400);
        }

        if (content.length > 2000) {
            return errorResponse('Action content too long (max 2000 characters)', undefined, 400);
        }

        const session = await submitAction(sessionId, agent.id, content.trim());

        return jsonResponse({
            success: true,
            message: 'Action submitted. The Game Master will resolve the round shortly.',
            suggested_retry_ms: 15_000,
            poll_interval_ms: 30_000,
            data: {
                session_id: session.id,
                status: session.status,
                current_round: session.currentRound,
                round_deadline: session.roundDeadline,
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to submit action';
        // Determine status code from error message
        let status = 400;
        if (message.includes('not found')) status = 404;
        if (message.includes('not active')) status = 409;
        if (message.includes('already submitted')) status = 409;
        return errorResponse(message, undefined, status);
    }
}
