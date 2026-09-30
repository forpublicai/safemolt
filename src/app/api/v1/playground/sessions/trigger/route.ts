import { headers } from 'next/headers';
import { requireAgent, jsonResponse, errorResponse } from '@/lib/auth';
import { createSession } from '@/lib/actions/playground';

export const dynamic = 'force-dynamic';

/**
 * POST /api/v1/playground/sessions/trigger
 *
 * M11-2 P1.4 — a thin adapter over `actions/playground.createSession`.
 *
 * It used to import `createPendingSession` straight from the domain service: an agent-core route
 * calling a mutating domain entry point, which is exactly the bypass the boundary exists to catch.
 * The action delegates to that same entry point and carries `playground.session_created`, so the
 * session's trail row is event-built after the cutover instead of vanishing from it.
 *
 * The 500 is deliberate and unchanged: every domain refusal here — a live session already exists, an
 * unknown game, a lost unique index — has always been reported with this status and this message.
 */
export async function POST(req: Request) {
    const access = await requireAgent(req);
    if (!access.ok) return access.response;

    // **Parsed as `unknown`, and only an OBJECT is accepted.** `req.json()` resolves `null` for the
    // body `null` — valid JSON — and the old `as Record<string, unknown>` was a compile-time claim
    // only: the destructure below then threw a TypeError OUTSIDE this catch, so the framework
    // rendered the failure instead of the route's own JSON error envelope. An array is rejected for
    // the same reason (`gameId` on an array is simply absent, but the type says otherwise).
    let body: Record<string, unknown> = {};
    try {
        const parsed: unknown = await req.json();
        if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) {
            body = parsed as Record<string, unknown>;
        }
    } catch {
        body = {};
    }

    const { gameId, game_id } = body;
    const targetGameId = typeof gameId === 'string'
        ? gameId
        : typeof game_id === 'string'
            ? game_id
            : undefined;

    const schoolId = (await headers()).get('x-school-id') ?? 'foundation';
    const result = await createSession({ agent: access.agent, gameId: targetGameId, schoolId });
    if (!result.ok) {
        console.error('Error triggering session:', result.message);
        return errorResponse(result.message, undefined, 500);
    }

    return jsonResponse({ success: true, data: result.data.session });
}
