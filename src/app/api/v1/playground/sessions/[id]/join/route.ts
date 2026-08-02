/**
 * POST /api/v1/playground/sessions/[id]/join
 * Agent joins a pending playground session.
 */
import { requireAgent, jsonResponse, errorResponse } from '@/lib/auth';
import { joinSession } from '@/lib/playground/session-manager';
import { FOUNDATION_SCHOOL_ID, requireSchoolAccess } from '@/lib/school-context';
import { getPlaygroundSession } from '@/lib/store';
import type { StoredAgent } from '@/lib/store-types';

export const dynamic = 'force-dynamic';

/**
 * The school that owns the *session* decides who may take part in it (M11-1 C20, review round 5).
 *
 * `requireAgent` answers "may this identity use SafeMolt", keyed on the host the request arrived
 * on. Session ids are public — `GET /api/v1/playground/sessions` lists them — so without this an
 * AO-unadmitted, Foundation-vetted agent could name an AO session, call the Foundation host, and
 * take part under the weaker rule. Participation in playground sessions drives billed GM inference,
 * which is exactly the spend C20 exists to keep behind the access rule.
 */
async function sessionSchoolDenial(agent: StoredAgent, sessionId: string): Promise<Response | null> {
    const session = await getPlaygroundSession(sessionId);
    if (!session) return null; // absence is the caller's own 404/400 to report
    return requireSchoolAccess(agent, session.schoolId ?? FOUNDATION_SCHOOL_ID);
}


export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id } = await params;
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const agent = access.agent;

    const schoolDenial = await sessionSchoolDenial(agent, id);
    if (schoolDenial) return schoolDenial;

    try {
        const text = await request.text();
        let actingBody:
            | { actingAsCompanyId?: string; actingAsLabel?: string; prefabId?: string }
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
                const prefabId = o.prefab_id;
                if (cid !== undefined || lbl !== undefined || prefabId !== undefined) {
                    actingBody = {
                        ...(typeof cid === 'string' ? { actingAsCompanyId: cid } : {}),
                        ...(typeof lbl === 'string' ? { actingAsLabel: lbl } : {}),
                        ...(typeof prefabId === 'string' ? { prefabId } : {}),
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
        if (message === 'invalid_prefab_id') {
            return errorResponse('Invalid prefab_id', 'Choose a prefab from /api/v1/playground/prefabs', 400, { code: 'invalid_prefab_id' });
        }
        return errorResponse(message, undefined, 400);
    }
}
