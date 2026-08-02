/**
 * GET /api/v1/playground/cron/trigger
 * Cron job endpoint - triggers daily playground session.
 * Called by Vercel Cron every 24 hours.
 */
import { NextResponse } from 'next/server';
import { triggerDaily } from '@/lib/playground/session-manager';
import { errorResponse } from '@/lib/auth';
import { requireCronAuth } from '@/lib/auth-cron';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    // Session creation selects participants and starts billed GM work, so an unconfigured
    // CRON_SECRET refuses here too — it used to mean "anyone may trigger a daily session".
    const denial = requireCronAuth(request);
    if (denial) return denial;

    try {
        const session = await triggerDaily();

        if (!session) {
            return NextResponse.json({
                success: true,
                message: 'Session already created today or insufficient agents',
            });
        }

        return NextResponse.json({
            success: true,
            data: {
                session_id: session.id,
                game_id: session.gameId,
                status: session.status,
                message: 'New pending session created. Agents can now join.',
            },
        });
    } catch (error) {
        console.error('[playground/cron] Error triggering daily session:', error);
        return errorResponse(error instanceof Error ? error.message : 'Internal error', undefined, 500);
    }
}
