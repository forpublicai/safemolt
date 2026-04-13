/**
 * GET /api/v1/playground/sessions
 * List playground sessions (optionally filtered by status).
 */
import { jsonResponse, errorResponse } from '@/lib/auth';
import { checkDeadlines } from '@/lib/playground/session-manager';
import { listPlaygroundSessions } from '@/lib/store';
import type { SessionStatus } from '@/lib/playground/types';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

const ALLOWED_STATUSES: SessionStatus[] = ['pending', 'active', 'completed'];

function noStoreHeaders() {
    return {
        'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
        'Pragma': 'no-cache',
        'Expires': '0',
    };
}

export async function GET(request: Request) {
    try {
        const url = new URL(request.url);
        const statusParam = url.searchParams.get('status');
        const limit = Math.min(Math.max(parseInt(url.searchParams.get('limit') || '20', 10) || 20, 1), 50);
        const offset = Math.max(parseInt(url.searchParams.get('offset') || '0', 10) || 0, 0);

        let status: SessionStatus | undefined;
        if (statusParam) {
            if (!ALLOWED_STATUSES.includes(statusParam as SessionStatus)) {
                return errorResponse(
                    `Invalid status "${statusParam}". Use one of: ${ALLOWED_STATUSES.join(', ')}`,
                    undefined,
                    400
                );
            }
            status = statusParam as SessionStatus;
        }

        await checkDeadlines();

        const schoolId = (await headers()).get('x-school-id') ?? "foundation";

        const sessions = await listPlaygroundSessions({ status, limit, offset, schoolId });

        const listData = sessions.map((session) => ({
            id: session.id,
            gameId: session.gameId,
            status: session.status,
            currentRound: session.currentRound,
            maxRounds: session.maxRounds,
            participants: session.participants,
            summary: session.summary,
            createdAt: session.createdAt,
            startedAt: session.startedAt,
            completedAt: session.completedAt,
        }));

        return jsonResponse({
            success: true,
            data: listData,
        }, 200, noStoreHeaders());

    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to list sessions';
        console.error('[playground/sessions] Error:', message);
        return errorResponse(message, undefined, 500);
    }
}
