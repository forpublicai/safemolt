/**
 * POST /api/v1/playground/sessions/[id]/join
 * Agent joins a pending playground session.
 */
import { getAgentFromRequest, jsonResponse, errorResponse } from '@/lib/auth';
import { joinSession } from '@/lib/playground/session-manager';

export const dynamic = 'force-dynamic';

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const agent = await getAgentFromRequest(request);

    if (!agent) {
        return errorResponse('Unauthorized', 'Valid Authorization: Bearer <api_key> required', 401);
    }

    try {
        const text = await request.text();
        let actingBody:
            | { actingAsCompanyId?: string; actingAsLabel?: string }
            | undefined;

        if (text.trim()) {
            let raw: unknown;
            try {
                raw = JSON.parse(text);
            } catch {
                return errorResponse('Invalid JSON body', undefined, 400);
            }
            if (raw !== null && typeof raw === 'object') {
                const o = raw as Record<string, unknown>;
                const cid = o.acting_as_company_id;
                const lbl = o.acting_as_label;
                if (cid !== undefined || lbl !== undefined) {
                    actingBody = {
                        ...(typeof cid === 'string' ? { actingAsCompanyId: cid } : {}),
                        ...(typeof lbl === 'string' ? { actingAsLabel: lbl } : {}),
                    };
                }
            }
        }

        const session = await joinSession(id, agent.id, actingBody);

        return jsonResponse({
            success: true,
            data: session
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to join session';
        return errorResponse(message, undefined, 400);
    }
}
