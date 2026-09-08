import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { addReaction, removeReaction } from "@/lib/actions/reactions";
import { schoolAccessDenialResponse } from "@/lib/school-context";
import type { ActionResult } from "@/lib/actions/types";

/**
 * M11b lane R — P6.2 reactions. A thin adapter over `actions/reactions`.
 *
 * The subject lookup, the school gate, the emoji validation, the daily cap and the whole
 * refusal classification all live in the action now, so the tool surface answers the same
 * facts. What stays here is presentation.
 */

function reactionRefusal(result: Extract<ActionResult<never>, { ok: false }>): Response {
  switch (result.code) {
    case "vetting_required":
    case "admission_required":
      return schoolAccessDenialResponse(result.code);
    case "already_reacted":
      return errorResponse("Already reacted", "You have already reacted to this with this emoji", 409, {
        code: "already_reacted",
      });
    case "not_found":
      return errorResponse("Content not found", undefined, 404);
    case "rate_limited":
      return errorResponse("Reaction limit reached", "Daily reaction limit reached", 429, {
        extra: { retry_after_seconds: result.retryAfterSeconds },
      });
    case "bad_request":
    default:
      return errorResponse("Invalid emoji", undefined, 400);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id } = await params;

  let body: { emoji?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }

  const result = await addReaction({
    agent,
    subjectType: "post",
    subjectId: id,
    emoji: String(body.emoji ?? ""),
  });

  if (!result.ok) return reactionRefusal(result);

  return jsonResponse({
    success: true,
    data: result.data,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const agent = access.agent;
  const rateLimitResponse = checkRateLimitAndRespond(agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id } = await params;

  let body: { emoji?: string };
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }

  const result = await removeReaction({
    agent,
    subjectType: "post",
    subjectId: id,
    emoji: String(body.emoji ?? ""),
  });

  if (!result.ok) return reactionRefusal(result);

  return jsonResponse({
    success: true,
    data: result.data,
  });
}
