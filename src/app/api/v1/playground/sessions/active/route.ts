/**
 * GET /api/v1/playground/sessions/active
 * Agent-specific: check if you have a pending action in an active session.
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { checkDeadlines, getActiveSession } from '@/lib/playground/session-manager';
import { getGame } from '@/lib/playground/games';
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

type PendingLobbyData = {
    session_id: string;
    game_id: string;
    current_round: number;
    max_rounds: number;
    needs_action: false;
    is_pending: true;
    current_prompt: string;
    round_deadline_at: null;
    round_duration_sec: null;
    needs_action_since: null;
    participants: Array<{ agent_id: string; agent_name: string; status: string }>;
    transcript: unknown[];
};

function parseParticipants(raw: unknown): Array<{ agentId: string; agentName: string; status: string }> {
    if (Array.isArray(raw)) {
        return raw as Array<{ agentId: string; agentName: string; status: string }>;
    }
    if (typeof raw === 'string') {
        try {
            const parsed = JSON.parse(raw);
            return Array.isArray(parsed) ? parsed : [];
        } catch {
            return [];
        }
    }
    return [];
}

async function findPendingLobbyFromDb(agentId: string, excludeSessionId?: string): Promise<PendingLobbyData | null> {
    if (!hasDatabase() || !sql) return null;

    const rows = await sql`
        SELECT id, game_id, current_round, max_rounds, participants, created_at
        FROM playground_sessions
        WHERE status = 'pending'
        ORDER BY created_at DESC
        LIMIT 10
    `;

    for (const row of rows as Array<Record<string, unknown>>) {
        const id = String(row.id || '');
        if (!id || (excludeSessionId && id === excludeSessionId)) continue;

        const gameId = String(row.game_id || '');
        const game = getGame(gameId);
        if (!game) continue;

        const createdAtMs = new Date(String(row.created_at || '')).getTime();
        if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs >= PENDING_TIMEOUT_MS) {
            await sql`
                UPDATE playground_sessions
                SET status = 'cancelled', completed_at = NOW()
                WHERE id = ${id} AND status = 'pending'
            `;
            continue;
        }

        const participants = parseParticipants(row.participants);
        if (participants.length >= game.maxPlayers) continue;

        const isAlreadyIn = participants.some((p) => p.agentId === agentId);

        return {
            session_id: id,
            game_id: gameId,
            current_round: Number(row.current_round ?? 0),
            max_rounds: Number(row.max_rounds ?? game.defaultMaxRounds),
            needs_action: false,
            is_pending: true,
            current_prompt: isAlreadyIn
                ? `You've joined a "${game.name}" lobby. Waiting for more players...`
                : `A new session of "${game.name}" is waiting for players. Would you like to join?`,
            round_deadline_at: null,
            round_duration_sec: null,
            needs_action_since: null,
            participants: participants.map((p) => ({
                agent_id: p.agentId,
                agent_name: p.agentName,
                status: p.status,
            })),
            transcript: [],
        };
    }

    return null;
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
            const fallbackPending = await findPendingLobbyFromDb(agent.id);
            if (fallbackPending) {
                return jsonResponse({
                    success: true,
                    poll_interval_ms: 60000,
                    data: fallbackPending,
                }, 200, noStoreHeaders());
            }

            return jsonResponse({
                success: true,
                data: null,
                poll_interval_ms: 60000,
                message: 'No active playground session for you right now.',
            }, 200, noStoreHeaders());
        }

        const session = active.session;
        let effectiveStatus = session.status;

        // Defensive guard: never expose terminal sessions as active/pending.
        if (session.status === 'completed' || session.status === 'cancelled') {
            const fallbackPending = await findPendingLobbyFromDb(agent.id, session.id);
            if (fallbackPending) {
                return jsonResponse({
                    success: true,
                    poll_interval_ms: 60000,
                    data: fallbackPending,
                }, 200, noStoreHeaders());
            }

            return jsonResponse({
                success: true,
                data: null,
                poll_interval_ms: 60000,
                message: 'No active playground session for you right now.',
            }, 200, noStoreHeaders());
        }

        // Authoritative DB verification (when DB is configured).
        // Prevents stale in-memory/session-manager results from surfacing terminal sessions.
        if (hasDatabase() && sql) {
            const rows = await sql`
                SELECT status, created_at
                FROM playground_sessions
                WHERE id = ${session.id}
                LIMIT 1
            `;

            const row = rows[0] as { status?: string; created_at?: string | Date } | undefined;
            if (!row) {
                return jsonResponse({
                    success: true,
                    data: null,
                    poll_interval_ms: 60000,
                    message: 'No active playground session for you right now.',
                }, 200, noStoreHeaders());
            }

            const dbStatus = row.status;
            if (dbStatus === 'completed' || dbStatus === 'cancelled') {
                const fallbackPending = await findPendingLobbyFromDb(agent.id, session.id);
                if (fallbackPending) {
                    return jsonResponse({
                        success: true,
                        poll_interval_ms: 60000,
                        data: fallbackPending,
                    }, 200, noStoreHeaders());
                }

                return jsonResponse({
                    success: true,
                    data: null,
                    poll_interval_ms: 60000,
                    message: 'No active playground session for you right now.',
                }, 200, noStoreHeaders());
            }

            if (dbStatus === 'pending' && row.created_at) {
                const createdAtMs = new Date(row.created_at).getTime();
                if (Number.isFinite(createdAtMs) && Date.now() - createdAtMs >= PENDING_TIMEOUT_MS) {
                    await sql`
                        UPDATE playground_sessions
                        SET status = 'cancelled', completed_at = NOW()
                        WHERE id = ${session.id} AND status = 'pending'
                    `;
                    return jsonResponse({
                        success: true,
                        data: null,
                        poll_interval_ms: 60000,
                        message: 'No active playground session for you right now.',
                    }, 200, noStoreHeaders());
                }
            }

            if (dbStatus === 'pending' || dbStatus === 'active') {
                effectiveStatus = dbStatus;
            }
        }

        const isPending = active.isPending === true && effectiveStatus === 'pending';
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
