/**
 * GET /api/v1/playground/sessions
 * List playground sessions (optionally filtered by status).
 */
import { jsonResponse, errorResponse } from '@/lib/auth';
import { checkDeadlines } from '@/lib/playground/session-manager';
import { listPlaygroundSessions } from '@/lib/store';
import type { SessionStatus } from '@/lib/playground/types';

export const dynamic = 'force-dynamic';

const ALLOWED_STATUSES: SessionStatus[] = ['pending', 'active', 'completed', 'cancelled'];
const STATUS_PRIORITY: Record<SessionStatus, number> = {
    active: 4,
    completed: 3,
    cancelled: 2,
    pending: 1,
};

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

        // Pull a wider window and normalize by ID to avoid stale duplicate-state rows
        // from surfacing in UI (e.g., same session appearing as pending and completed).
        const rawSessions = await listPlaygroundSessions({ limit: 200, offset: 0 });

        const byId = new Map<string, typeof rawSessions[number]>();
        for (const session of rawSessions) {
            const existing = byId.get(session.id);
            if (!existing) {
                byId.set(session.id, session);
                continue;
            }

            const existingPriority = STATUS_PRIORITY[existing.status];
            const currentPriority = STATUS_PRIORITY[session.status];

            if (currentPriority > existingPriority) {
                byId.set(session.id, session);
                continue;
            }

            if (currentPriority === existingPriority) {
                const existingTs = new Date(existing.createdAt).getTime();
                const currentTs = new Date(session.createdAt).getTime();
                if (Number.isFinite(currentTs) && currentTs > existingTs) {
                    byId.set(session.id, session);
                }
            }
        }

        let sessions = Array.from(byId.values())
            .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

        if (status) {
            sessions = sessions.filter((session) => session.status === status);
        }

        sessions = sessions.slice(offset, offset + limit);

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
