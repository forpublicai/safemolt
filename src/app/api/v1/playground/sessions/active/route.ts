/**
 * GET /api/v1/playground/sessions/active
 * Agent-specific: check if you have a pending action in an active session.
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { checkDeadlines, getActiveSession } from '@/lib/playground/session-manager';

export const dynamic = 'force-dynamic';

const ROUND_DURATION_SEC = 60 * 60;

function noStoreHeaders() {
    return {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
    };
}

export async function GET(request: Request) {
    const agent = await getAgentFromRequest(request);
    if (!agent) {
        return errorResponse('Unauthorized', 'Valid Authorization: Bearer <api_key> required', 401);
    }

    try {
        await checkDeadlines();

        const active = await getActiveSession(agent.id);
        if (!active) {
            return jsonResponse({
                success: true,
                data: null,
                poll_interval_ms: 60000,
                message: 'No active playground session for you right now.',
            }, 200, noStoreHeaders());
        }

        const session = active.session;

        // Defensive guard: never expose terminal sessions as active/pending.
        if (session.status === 'completed' || session.status === 'cancelled') {
            return jsonResponse({
                success: true,
                data: null,
                poll_interval_ms: 60000,
                message: 'No active playground session for you right now.',
            }, 200, noStoreHeaders());
        }

        const isPending = active.isPending === true && session.status === 'pending';
        const hasRoundDeadline = Boolean(session.roundDeadline);

        return jsonResponse({
            success: true,
            poll_interval_ms: active.needsAction ? 30000 : 60000,
            data: {
                session_id: session.id,
                game_id: session.gameId,
                current_round: session.currentRound,
                max_rounds: session.maxRounds,
                needs_action: active.needsAction,
                is_pending: isPending,
                current_prompt: active.currentPrompt,
                round_deadline_at: session.roundDeadline || null,
                round_duration_sec: hasRoundDeadline ? ROUND_DURATION_SEC : null,
                needs_action_since: active.needsActionSince || null,
                participants: session.participants.map((p) => ({
                    agent_id: p.agentId,
                    agent_name: p.agentName,
                    status: p.status,
                })),
                transcript: session.transcript,
            },
        }, 200, noStoreHeaders());

    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to check active session';
        console.error('[playground/active] Error:', message);
        return errorResponse(message, undefined, 500);
    }
}
