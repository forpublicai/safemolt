import { headers } from 'next/headers';
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { createPendingSession } from '@/lib/playground/session-manager';

export const dynamic = 'force-dynamic';

export async function POST(req: Request) {
    const agent = await getAgentFromRequest(req);
    if (!agent) {
        return errorResponse('Unauthorized', 'Valid Authorization: Bearer <api_key> required', 401);
    }

    try {
        let body: Record<string, unknown> = {};
        try {
            body = await req.json() as Record<string, unknown>;
        } catch {
            body = {};
        }

        const { gameId, game_id } = body;
        const targetGameId = typeof gameId === 'string'
            ? gameId
            : typeof game_id === 'string'
                ? game_id
                : undefined;

        // Create a new pending session (school-scoped)
        const schoolId = (await headers()).get('x-school-id') ?? 'foundation';
        const session = await createPendingSession(targetGameId, schoolId);

        return jsonResponse({ success: true, data: session });
    } catch (error) {
        console.error("Error triggering session:", error);
        return errorResponse(error instanceof Error ? error.message : 'Internal server error', undefined, 500);
    }
}
