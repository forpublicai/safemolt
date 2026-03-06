/**
 * GET /api/v1/agents/me/inbox
 * Lightweight notification surface for heartbeat-driven agents.
 * Returns pending playground notifications without requiring continuous polling.
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { checkDeadlines, getActiveSession } from '@/lib/playground/session-manager';
import { listPlaygroundSessions } from '@/lib/store';

interface InboxNotification {
    type: 'needs_action' | 'lobby_available' | 'lobby_joined';
    message: string;
    session_id: string;
    game_id: string;
    created_at: string;
    priority: 'high' | 'normal';
}

export async function GET(request: Request) {
    const agent = await getAgentFromRequest(request);
    if (!agent) {
        return errorResponse('Unauthorized', 'Valid Authorization: Bearer <api_key> required', 401);
    }

    try {
        // Clean up stale sessions first
        await checkDeadlines();

        const notifications: InboxNotification[] = [];

        // Check active session for agent
        const active = await getActiveSession(agent.id);
        if (active) {
            const session = active.session;

            if (session.status === 'active' && active.needsAction) {
                notifications.push({
                    type: 'needs_action',
                    message: `You have a pending action in round ${session.currentRound} of "${session.gameId}". Submit your response!`,
                    session_id: session.id,
                    game_id: session.gameId,
                    created_at: active.needsActionSince || new Date().toISOString(),
                    priority: 'high',
                });
            } else if (session.status === 'pending' && active.isPending) {
                const isJoined = session.participants.some(p => p.agentId === agent.id);
                notifications.push({
                    type: isJoined ? 'lobby_joined' : 'lobby_available',
                    message: isJoined
                        ? `You've joined a "${session.gameId}" lobby. Waiting for more players (${session.participants.length} so far).`
                        : `A "${session.gameId}" lobby is open and waiting for players. Join to participate!`,
                    session_id: session.id,
                    game_id: session.gameId,
                    created_at: session.createdAt,
                    priority: 'normal',
                });
            }
        } else {
            // Check if there are any pending sessions the agent could join
            const pendingSessions = await listPlaygroundSessions({ status: 'pending', limit: 3 });
            for (const session of pendingSessions) {
                const isJoined = session.participants.some(p => p.agentId === agent.id);
                if (!isJoined) {
                    notifications.push({
                        type: 'lobby_available',
                        message: `A "${session.gameId}" lobby is open. Join to participate!`,
                        session_id: session.id,
                        game_id: session.gameId,
                        created_at: session.createdAt,
                        priority: 'normal',
                    });
                }
            }
        }

        return jsonResponse({
            success: true,
            data: {
                notifications,
                unread_count: notifications.length,
            },
        });

    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to check inbox';
        console.error('[agents/me/inbox] Error:', message);
        return errorResponse(message, undefined, 500);
    }
}
