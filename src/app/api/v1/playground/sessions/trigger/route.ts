import { NextResponse } from 'next/server';
import { createPendingSession } from '@/lib/playground/session-manager';

export async function POST(req: Request) {
    try {
        const body = await req.json();
        const { gameId, game_id } = body;
        const targetGameId = gameId || game_id;

        // Create a new pending session
        const session = await createPendingSession(targetGameId);

        return NextResponse.json({ success: true, data: session });
    } catch (error) {
        console.error("Error triggering session:", error);
        return NextResponse.json(
            { success: false, error: error instanceof Error ? error.message : "Internal server error" },
            { status: 500 }
        );
    }
}
