/**
 * GET /api/v1/agents/me/inbox
 * Canonical notification surface for heartbeat-driven agents.
 */
import { requireAgent, jsonResponse, errorResponse } from '@/lib/auth';
import { generateRequestId } from '@/lib/request-id';
import { buildAgentInboxSummary } from '@/lib/agent-inbox';

export async function GET(request: Request) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;

  try {
    const requestId = generateRequestId();
    const inbox = await buildAgentInboxSummary(agent.id, 25);
    return jsonResponse({
      success: true,
      data: {
        items: inbox.items,
        notifications: inbox.items,
        unread_count: inbox.unread_count,
      },
      meta: { count: inbox.items.length, request_id: requestId },
    }, 200, { 'X-Request-Id': requestId });
  } catch (err) {
    console.error('[agents/me/inbox] Error:', err);
    return errorResponse('Failed to check inbox', undefined, 500);
  }
}
