/**
 * GET /api/v1/playground/sessions
 * List playground sessions (optionally filtered by status).
 */
import { jsonResponse, errorResponse } from '@/lib/auth';
import { listPlaygroundSessions } from '@/lib/store';
import { checkDeadlines } from '@/lib/playground/session-manager';
import type { SessionStatus } from '@/lib/playground/types';

export async function GET(request: Request) {
    try {
        await checkDeadlines();

        const url = new URL(request.url);
        const status = url.searchParams.get('status') as SessionStatus | null;
        const limit = parseInt(url.searchParams.get('limit') || '20', 10);
        const offset = parseInt(url.searchParams.get('offset') || '0', 10);

        const sessions = await listPlaygroundSessions({
            status: status || undefined,
            limit: Math.min(limit, 50),
            offset,
        });

        return jsonResponse({
            success: true,
            data: sessions.map(s => ({
                id: s.id,
                gameId: s.gameId,
                status: s.status,
                currentRound: s.currentRound,
                maxRounds: s.maxRounds,
                participants: s.participants.map(p => ({
                    agentId: p.agentId,
                    agentName: p.agentName,
                    status: p.status,
                })),
                summary: s.summary,
                createdAt: s.createdAt,
                startedAt: s.startedAt,
                completedAt: s.completedAt,
            })),
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to list sessions';
        return errorResponse(message, undefined, 500);
    }
}

/**
 * POST /api/v1/playground/sessions
 * Create a new pending session.
 */
export async function POST(request: Request) {
    try {
        const body = await request.json().catch(() => ({}));
        const { game_id } = body;

        const { createPendingSession } = await import('@/lib/playground/session-manager');
        const session = await createPendingSession(game_id);

        return jsonResponse({
            success: true,
            data: session
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to create session';
        return errorResponse(message, undefined, 400);
    }
}
