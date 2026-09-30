/**
 * POST /api/v1/playground/sessions/[id]/action
 *
 * M11-2 P1.4 — a thin adapter over `actions/playground.submitAction`.
 *
 * The session's school gate moved into the action (it is the same decision the tool surface now
 * shares); this handler keeps rendering it in the platform-access envelope its clients already
 * parse. Content validation stays here: it is an input rule, and both surfaces already differ on it
 * — the tool has never had a length bound.
 *
 * M11-1 C3's note still holds: there is no global `checkDeadlines()` here. Progression is
 * target-scoped and post-insert (`submitAction` fire-and-forgets `tryAdvanceRound`), so a rejected
 * principal spends nothing.
 */
import { requireAgent, jsonResponse, errorResponse } from '@/lib/auth';
import { submitAction } from '@/lib/actions/playground';
import { schoolAccessDenialResponse } from '@/lib/school-context';

export const dynamic = 'force-dynamic';

/** The status this surface derives from the refusal's wording — unchanged, and pinned. */
function statusForMessage(message: string): number {
    if (message.includes('not found')) return 404;
    if (message.includes('not active')) return 409;
    if (message.includes('already submitted')) return 409;
    // M11-1 C12: the action-vs-advance race, refused instead of silently dropped.
    if (message.includes('resolved') || message.includes('being resolved')) return 409;
    return 400;
}

export async function POST(
    request: Request,
    { params }: { params: Promise<{ id: string }> }
) {
    const { id: sessionId } = await params;

    const access = await requireAgent(request);
    if (!access.ok) return access.response;

    let content: unknown;
    try {
        content = ((await request.json()) as { content?: unknown }).content;
    } catch {
        content = undefined;
    }

    // **Authorization first, deliberately** (Locked decision 3): the school gate lives in the action
    // and a refused principal must reach no validation and no write. So an empty submission by a
    // school-denied agent answers 403, exactly as it did when this handler ran the gate itself —
    // which is what the characterization suite pins.
    const validation =
        typeof content !== 'string' || content.trim().length === 0
            ? 'Missing or empty "content" field'
            : content.length > 2000
              ? 'Action content too long (max 2000 characters)'
              : null;

    const result = await submitAction({
        agent: access.agent,
        sessionId,
        content: typeof content === 'string' ? content.trim() : '',
        // The action must not write when the input is invalid; it is told so rather than being
        // handed a value it would have to guess about.
        ...(validation === null ? {} : { refuseWith: validation }),
    });
    if (!result.ok) {
        switch (result.code) {
            case 'vetting_required':
            case 'admission_required':
                return schoolAccessDenialResponse(result.code);
            default:
                return errorResponse(result.message, undefined, statusForMessage(result.message));
        }
    }

    const { session } = result.data;
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
}
