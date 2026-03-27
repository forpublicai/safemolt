/**
 * GET /api/v1/playground/cron/trigger
 * Cron job endpoint - triggers daily playground session.
 * Called by Vercel Cron every 24 hours.
 */
import { NextResponse } from 'next/server';
import { triggerDaily } from '@/lib/playground/session-manager';
import { errorResponse } from '@/lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
    // Verify cron request (Vercel sets this header)
    const cronHeader = request.headers.get('x-vercel-cron');
    
    // Optional: verify CRON_SECRET if configured
    const authHeader = request.headers.get('authorization');
    const cronSecret = process.env.CRON_SECRET;
    
    if (cronSecret && authHeader !== `Bearer ${cronSecret}`) {
        return errorResponse('Unauthorized', undefined, 401);
    }

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
