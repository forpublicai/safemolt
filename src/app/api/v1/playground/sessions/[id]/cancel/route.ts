/**
 * POST /api/v1/playground/sessions/[id]/cancel — M11-1 C3.
 *
 * Cancellation is an attributed terminal transition, not a delete: the session survives with
 * status 'cancelled', who cancelled it, why, and when. A `reason` is required (rejected with the
 * stable `reason_required` before any lookup). The store's single conditional UPDATE is both the
 * authorization (participant containment) and the mutation; a nonparticipant's answer is
 * indistinguishable from a nonexistent session.
 *
 * The pre-C3 handler called the GLOBAL checkDeadlines() before even reading the target — a
 * nonparticipant about to be rejected could drive paid GM inference across unrelated sessions
 * (a Locked-decision-3 violation no lease fixes). Cancellation needs no progression at all, so
 * this handler now touches only its target.
 */
import { requireAgent, jsonResponse, errorResponse } from '@/lib/auth';
import { cancelSession } from '@/lib/actions/playground';
import type { CancelPlaygroundOutcome } from '@/lib/playground/types';

export const dynamic = 'force-dynamic';

const MAX_REASON_LENGTH = 500;

/**
 * Stored verbatim as text — never interpolated into SQL, never rendered unescaped. Emptiness is
 * judged on the trimmed value (whitespace-only is rejected), but the ACCEPTED string is stored as
 * submitted (M11-1b review B10): the audit contract is verbatim, and trimming before storage would
 * quietly alter the recorded reason. Length is bounded on the raw value.
 */
function validateReason(body: unknown): { reason: string } | { response: Response } {
  const raw = (body as { reason?: unknown } | null)?.reason;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    return {
      response: errorResponse(
        'reason is required',
        'Cancellations are recorded with who cancelled and why. Provide a non-empty reason.',
        400,
        { code: 'reason_required' }
      ),
    };
  }
  if (raw.length > MAX_REASON_LENGTH) {
    return {
      response: errorResponse(
        'reason too long',
        `Maximum ${MAX_REASON_LENGTH} characters.`,
        400,
        { code: 'reason_required' }
      ),
    };
  }
  return { reason: raw };
}

function respondForOutcome(sessionId: string, outcome: CancelPlaygroundOutcome): Response {
  switch (outcome.outcome) {
    case 'cancelled':
      return jsonResponse({
        success: true,
        message: 'Session cancelled',
        data: {
          session_id: sessionId,
          previous_status: outcome.previousStatus,
        },
      });
    case 'resolution_in_progress':
      // An already-claimed round is paid work in flight; cancelling it would spend the money and
      // discard the result. Retry once the round settles.
      return errorResponse(
        'Round resolution in progress',
        'A round of this session is being resolved. Retry once it settles.',
        409,
        { code: 'resolution_in_progress' }
      );
    case 'not_cancellable':
      return outcome.status === 'cancelled'
        ? errorResponse('Session already cancelled', undefined, 409)
        : errorResponse('Completed sessions cannot be cancelled', undefined, 409);
    case 'not_found':
      return errorResponse('Session not found', undefined, 404);
  }
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params;

  const access = await requireAgent(request);
  if (!access.ok) return access.response;

  try {
    let body: unknown = null;
    try {
      body = await request.json();
    } catch {
      // fall through — a missing body is the same failure as a missing reason
    }
    const validated = validateReason(body);
    if ('response' in validated) return validated.response;

    // M11-2 P1.4 — an adapter over `actions/playground.cancelSession`. The action carries the
    // `playground.session_cancelled` event; the store's participant-scoped UPDATE is still both the
    // authorization and the gate, so a nonparticipant writes nothing and emits nothing.
    const result = await cancelSession({ agent: access.agent, sessionId: id, reason: validated.reason });
    if (!result.ok) return errorResponse(result.message, undefined, 400);
    return respondForOutcome(id, result.data);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Failed to cancel session';
    return errorResponse(message, undefined, 500);
  }
}
