/**
 * POST /api/v1/playground/sessions/[id]/cancel
 * Cancel an existing playground session.
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { checkDeadlines } from '@/lib/playground/session-manager';
import { getPlaygroundSession, updatePlaygroundSession } from '@/lib/store';
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

    if (session.status === 'cancelled') {
      return jsonResponse({
        success: true,
        message: 'Session is already cancelled',
        data: {
          session_id: session.id,
          status: session.status,
        },
      });
    }

    const cancelledAt = new Date().toISOString();
    await updatePlaygroundSession(id, {
      status: 'cancelled',
      completedAt: cancelledAt,
    });

    if (session.status === 'active') {
      clearWorldState(id);
      clearReasoningChain(id);
    }

    return jsonResponse({
      success: true,
      message: 'Session cancelled',
      data: {
        session_id: session.id,
        previous_status: session.status,
        status: 'cancelled',
        cancelled_at: cancelledAt,
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to cancel session';
    return errorResponse(message, undefined, 500);
  }
}
