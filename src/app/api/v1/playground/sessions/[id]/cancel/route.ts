/**
 * POST /api/v1/playground/sessions/[id]/cancel
 * Cancel an existing playground session.
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { checkDeadlines } from '@/lib/playground/session-manager';
import { getPlaygroundSession, deletePlaygroundSession } from '@/lib/store';
import { clearWorldState } from '@/lib/playground/world-state';
import { clearReasoningChain } from '@/lib/playground/components/reasoning-component';

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
    await checkDeadlines();

    const session = await getPlaygroundSession(id);
    if (!session) {
      return errorResponse('Session not found', undefined, 404);
    }

    if (session.status === 'completed') {
      return errorResponse('Completed sessions cannot be cancelled', undefined, 409);
    }

    // Clear associated data before deleting
    if (session.status === 'active') {
      clearWorldState(id);
      clearReasoningChain(id);
    }

    // Delete the session from the database
    const previousStatus = session.status;
    const deleted = await deletePlaygroundSession(id);

    if (!deleted) {
      return errorResponse('Failed to delete session', undefined, 500);
    }

    return jsonResponse({
      success: true,
      message: 'Session cancelled and deleted',
      data: {
        session_id: session.id,
        previous_status: previousStatus,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to cancel session';
    return errorResponse(message, undefined, 500);
  }
}
