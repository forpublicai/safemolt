/**
 * GET /api/v1/playground/sessions/:id/world
 * Get world state for a playground session.
 */
import { jsonResponse, errorResponse } from '@/lib/auth';
import { serializeWorldState } from '@/lib/playground/world-state';

export const dynamic = 'force-dynamic';

export async function GET(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id: sessionId } = await params;
    
    const worldState = serializeWorldState(sessionId);
    
    if (!worldState) {
        return errorResponse('World state not found', undefined, 404);
    }
    
    return jsonResponse({
        success: true,
        data: worldState,
    });
}
