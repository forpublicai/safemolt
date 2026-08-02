/**
 * POST /api/v1/playground/sessions/[id]/action
 * Agent submits their action for the current round.
 * After storing, triggers tryAdvanceRound().
 */
import { requireAgent, jsonResponse, errorResponse } from '@/lib/auth';
import { submitAction } from '@/lib/playground/session-manager';
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
    const { id: sessionId } = await params;

    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const agent = access.agent;

    // Before `checkDeadlines`, deliberately: that call advances rounds and can trigger paid GM
    // inference, and Locked decision 3 puts authorization ahead of any expensive work — a refused
    // principal must also spend nothing.
    const schoolDenial = await sessionSchoolDenial(agent, sessionId);
    if (schoolDenial) return schoolDenial;

    try {
        // M11-1 C3: the GLOBAL checkDeadlines() call is gone from this handler — it reached
        // billed GM inference across unrelated sessions before the caller's participation was
        // ever checked. Progression is now strictly target-scoped and post-insert: submitAction
        // fire-and-forgets tryAdvanceRound(sessionId) only after the gated insert admitted a
        // participant, so a rejected principal spends nothing. The global sweep belongs to the
        // fail-closed cron (internal/playground-deadlines); the unauthenticated session GET keeps
        // its opportunistic call as the one named exception, with C12's lease as its cost bound.
        const body = await request.json();
        const content = (body as { content?: string }).content;

        if (!content || typeof content !== 'string' || content.trim().length === 0) {
            return errorResponse('Missing or empty "content" field', undefined, 400);
        }

        if (content.length > 2000) {
            return errorResponse('Action content too long (max 2000 characters)', undefined, 400);
        }

        const { session } = await submitAction(sessionId, agent.id, content.trim());

        return jsonResponse({
            success: true,
            message: 'Action submitted. The Game Master will resolve the round shortly.',
            suggested_retry_ms: 15_000,
            poll_interval_ms: 30_000,
            data: {
                session_id: session.id,
                status: session.status,
                current_round: session.currentRound,
                round_deadline: session.roundDeadline,
            },
        });
    } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to submit action';
        // Determine status code from error message
        let status = 400;
        if (message.includes('not found')) status = 404;
        if (message.includes('not active')) status = 409;
        if (message.includes('already submitted')) status = 409;
        // M11-1 C12: the action-vs-advance race, refused instead of silently dropped.
        if (message.includes('resolved') || message.includes('being resolved')) status = 409;
        return errorResponse(message, undefined, status);
    }
}
