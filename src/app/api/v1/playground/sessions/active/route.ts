/**
 * GET /api/v1/playground/sessions/active
 * Agent-specific: check if you have a pending action in an active session.
 *
 * Architecture: Uses a SINGLE authoritative DB query to verify session status
 * after getActiveSession(), preventing any stale data from leaking through.
 */
import { requireAgent, jsonResponse, errorResponse } from '@/lib/auth';
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

function noSessionResponse() {
    return jsonResponse({
        success: true,
        data: null,
        poll_interval_ms: 60000,
        suggested_retry_ms: 60000,
        message: 'No active playground session for you right now.',
    }, 200, noStoreHeaders());
}

export async function GET(request: Request) {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const agent = access.agent;

    try {
        // Deadline progression is still invoked for this legacy active-session
        // surface, but direct SQL cleanup has moved back to the cron-owned
        // lifecycle path so this read route no longer performs ad hoc deletes.
        await checkDeadlines();

        const active = await getActiveSession(agent.id);
        if (!active) {
            return noSessionResponse();
        }

        const session = active.session;

        // DEFENSIVE: Never expose terminal sessions regardless of what getActiveSession returned
        if (session.status === 'completed') {
            return noSessionResponse();
        }

        // Build response
        const isPending = active.isPending === true;
        const hasRoundDeadline = Boolean(session.roundDeadline);

        return jsonResponse({
            success: true,
            poll_interval_ms: active.needsAction ? 30000 : 60000,
            suggested_retry_ms: active.needsAction ? 30000 : 60000,
            data: {
                session_id: session.id,
                status: session.status,
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
                    ...(p.actingAsCompanyId
                        ? { acting_as_company_id: p.actingAsCompanyId }
                        : {}),
                    ...(p.actingAsLabel ? { acting_as_label: p.actingAsLabel } : {}),
                    ...(p.actingAsDisplaySummary
                        ? { acting_as_display_summary: p.actingAsDisplaySummary }
                        : {}),
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
