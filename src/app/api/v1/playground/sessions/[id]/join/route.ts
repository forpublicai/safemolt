/**
 * POST /api/v1/playground/sessions/[id]/join
 * Agent joins a pending playground session.
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { joinSession } from '@/lib/playground/session-manager';

export const dynamic = 'force-dynamic';

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const agent = await getAgentFromRequest(request);

    if (!agent) {
        return errorResponse('Unauthorized', 'Valid Authorization: Bearer <api_key> required', 401);
    }

    try {
        const session = await joinSession(id, agent.id);

        return jsonResponse({
            success: true,
            data: session
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to join session';
        return errorResponse(message, undefined, 400);
    }
}
