/**
 * GET /api/v1/playground/prefabs
 * List available agent prefabs (personality templates).
 */
import { jsonResponse } from '@/lib/auth';
import { listPrefabs } from '@/lib/playground/prefabs';

export async function GET() {
    const prefabs = listPrefabs();

    return jsonResponse({
        success: true,
        data: prefabs.map(p => ({
            id: p.id,
            name: p.name,
            description: p.description,
            traits: {
                openness: p.traits.openness,
                conscientiousness: p.traits.conscientiousness,
                extraversion: p.traits.extraversion,
                agreeableness: p.traits.agreeableness,
                neuroticism: p.traits.neuroticism,
            },
            memory_strategy: {
                relationship_focus: p.memoryStrategy.relationshipFocus,
                plan_focus: p.memoryStrategy.planFocus,
                observation_focus: p.memoryStrategy.observationFocus,
            },
        })),
    });
}
