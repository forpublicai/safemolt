/**
 * POST /api/v1/playground/sessions/[id]/join
 *
 * M11-2 P1.4 — a thin adapter over `actions/playground.joinSession`.
 *
 * The school gate moved into the action, where the tool surface shares it; this handler keeps its
 * own envelope for it, because the two surfaces publish different wording for the same decision and
 * the characterization suite pins both.
 */
import { requireAgent, jsonResponse, errorResponse } from '@/lib/auth';
import { joinSession } from '@/lib/actions/playground';
import { schoolAccessDenialResponse } from '@/lib/school-context';

export const dynamic = 'force-dynamic';

/** The optional acting-affiliation body, in the snake_case the public API speaks. */
function parseActingBody(text: string):
    | { ok: true; body: { actingAsCompanyId?: string; actingAsLabel?: string; prefabId?: string } }
    | { ok: false } {
    if (!text.trim()) return { ok: true, body: {} };
    let raw: unknown;
    try {
        raw = JSON.parse(text);
    } catch {
        return { ok: false };
    }
    if (raw === null || typeof raw !== 'object') return { ok: true, body: {} };
    const o = raw as Record<string, unknown>;
    return {
        ok: true,
        body: {
            ...(typeof o.acting_as_company_id === 'string' ? { actingAsCompanyId: o.acting_as_company_id } : {}),
            ...(typeof o.acting_as_label === 'string' ? { actingAsLabel: o.acting_as_label } : {}),
            ...(typeof o.prefab_id === 'string' ? { prefabId: o.prefab_id } : {}),
        },
    };
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const access = await requireAgent(request);
    if (!access.ok) return access.response;

    const parsed = parseActingBody(await request.text());
    if (!parsed.ok) return errorResponse('Invalid JSON body', undefined, 400);

    const result = await joinSession({ agent: access.agent, sessionId: id, ...parsed.body });
    if (!result.ok) {
        switch (result.code) {
            case 'vetting_required':
            case 'admission_required':
                return schoolAccessDenialResponse(result.code);
            default:
                // Every domain refusal — including "Session not found" — has always been a 400 here.
                return result.message === 'invalid_prefab_id'
                    ? errorResponse('Invalid prefab_id', 'Choose a prefab from /api/v1/playground/prefabs', 400, {
                          code: 'invalid_prefab_id',
                      })
                    : errorResponse(result.message, undefined, 400);
        }
    }

    return jsonResponse({ success: true, data: result.data.session });
}
