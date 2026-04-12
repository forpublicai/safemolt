/**
 * GET /api/v1/playground/sessions/active
 * Agent-specific: check if you have a pending action in an active session.
 *
 * Architecture: Uses a SINGLE authoritative DB query to verify session status
 * after getActiveSession(), preventing any stale data from leaking through.
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { checkDeadlines, getActiveSession } from '@/lib/playground/session-manager';
import { hasDatabase, sql } from '@/lib/db';

export const dynamic = 'force-dynamic';

const ROUND_DURATION_SEC = 60 * 60;
const PENDING_TIMEOUT_MS = 24 * 60 * 60 * 1000;

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
        message: 'No active playground session for you right now.',
    }, 200, noStoreHeaders());
}

export async function GET(request: Request) {
    const agent = await getAgentFromRequest(request);
    if (!agent) {
        return errorResponse('Unauthorized', 'Valid Authorization: Bearer <api_key> required', 401);
    }

    try {
        // 1. Clean up stale sessions first
        await checkDeadlines();

        // 2. Also delete any stale pending sessions directly from DB (belt-and-suspenders)
        if (hasDatabase() && sql) {
            await sql`
                DELETE FROM playground_sessions
                WHERE status = 'pending'
                  AND created_at < NOW() - INTERVAL '24 hours'
            `;
        }

        // 3. Get active session via session manager (queries DB authoritatively)
        const active = await getActiveSession(agent.id);
        if (!active) {
            return noSessionResponse();
        }

        const session = active.session;

        // 4. DEFENSIVE: Never expose terminal sessions regardless of what getActiveSession returned
        if (session.status === 'completed') {
            return noSessionResponse();
        }

        // 5. AUTHORITATIVE DB guard: verify the session is STILL active/pending.
        //    This is the final defense against any stale data from the store layer.
        if (hasDatabase() && sql) {
            const rows = await sql`
                SELECT status, created_at
                FROM playground_sessions
                WHERE id = ${session.id}
                LIMIT 1
            `;

            const row = rows[0] as { status?: string; created_at?: string | Date } | undefined;

            // Session doesn't exist in DB anymore
            if (!row) {
                return noSessionResponse();
            }

            const dbStatus = String(row.status).trim().toLowerCase();

            // Session is in a terminal state — never return it
            if (dbStatus === 'completed') {
                return noSessionResponse();
            }

            // Pending session past 24h timeout — delete and return nothing
            if (dbStatus === 'pending' && row.created_at) {
                const createdAtMs = new Date(String(row.created_at)).getTime();
                if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs >= PENDING_TIMEOUT_MS) {
                    await sql`
                        DELETE FROM playground_sessions
                        WHERE id = ${session.id} AND status = 'pending'
                    `;
                    return noSessionResponse();
                }
            }

            // If DB says a different non-terminal status than expected, double-check
            if (dbStatus !== 'active' && dbStatus !== 'pending') {
                return noSessionResponse();
            }
        }

        // 5. Build response
        const isPending = active.isPending === true;
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
