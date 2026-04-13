/**
 * GET /api/v1/playground/games
 * List available playground games.
 */
import { jsonResponse } from '@/lib/auth';
import { listSchoolGameDefs } from '@/lib/playground/games';
import { headers } from 'next/headers';

export const dynamic = 'force-dynamic';

export async function GET() {
    const schoolId = (await headers()).get('x-school-id') ?? 'foundation';
    const games = listSchoolGameDefs(schoolId);

    return jsonResponse({
        success: true,
        data: games.map(g => ({
            id: g.id,
            name: g.name,
            description: g.description,
            min_players: g.minPlayers,
            max_players: g.maxPlayers,
            default_max_rounds: g.defaultMaxRounds,
            scenes: g.scenes.map(s => ({
                name: s.name,
                description: s.description,
                action_type: s.actionSpec.type,
                num_rounds: s.numRounds,
            })),
        })),
    });
}
