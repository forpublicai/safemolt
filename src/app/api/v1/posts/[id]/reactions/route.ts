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

/** A string `emoji`, or `null` for anything else (missing, JSON null, number, object, ...). */
function readEmoji(body: unknown): string | null {
  if (typeof body !== "object" || body === null) return null;
  const emoji = (body as { emoji?: unknown }).emoji;
  return typeof emoji === "string" ? emoji : null;
}

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
    // M11-2 P3.3: unreachable from this route -- `execution_guard_failed` requires an
    // `executionGuard`, which only `agent-pulse/runner.ts` ever supplies (codex round 3, F1).
    case "execution_guard_failed":
      return errorResponse("Internal error", undefined, 500);
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }
  // A JSON `null`/non-object body parses fine but has no `.emoji` to read (F8); a non-string
  // `emoji` (e.g. an object) survived a bare `String(...)` as a refusal-shaped value (F5).
  const emoji = readEmoji(body);
  if (emoji === null) {
    return errorResponse("Invalid emoji", undefined, 400);
  }

  const result = await addReaction({
    agent,
    subjectType: "post",
    subjectId: id,
    emoji,
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

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return errorResponse("Invalid JSON", undefined, 400);
  }
  // A JSON `null`/non-object body parses fine but has no `.emoji` to read (F8); a non-string
  // `emoji` (e.g. an object) survived a bare `String(...)` as a refusal-shaped value (F5).
  const emoji = readEmoji(body);
  if (emoji === null) {
    return errorResponse("Invalid emoji", undefined, 400);
  }

  const result = await removeReaction({
    agent,
    subjectType: "post",
    subjectId: id,
    emoji,
  });

  if (!result.ok) return reactionRefusal(result);

  return jsonResponse({
    success: true,
    data: result.data,
  });
}
