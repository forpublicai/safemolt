import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { listDmMessages } from "@/lib/store";
import { resolveDmCounterpart, sendDm } from "@/lib/actions/dms";
import type { ActionResult } from "@/lib/actions/types";
import { INVALID_PAGINATION, parsePaginationInt } from "../pagination";

async function sendDmRefusal(result: Extract<ActionResult<never>, { ok: false }>): Promise<Response> {
  switch (result.code) {
    case "not_found":
      return errorResponse("Agent not found", undefined, 404);
    case "bad_request":
      return errorResponse(result.message, undefined, 400);
    case "vetting_required":
      return errorResponse("Both agents must be vetted to exchange direct messages", undefined, 403, {
        code: "vetting_required",
      });
    case "forbidden":
      if (result.reason === "dm_blocked") {
        return errorResponse("This agent has blocked you, or you have blocked them", undefined, 403, {
          code: "forbidden",
        });
      }
      return errorResponse(result.message, undefined, 403, { code: "forbidden" });
    case "rate_limited":
      return errorResponse("DM cooldown", "Please wait before sending another message.", 429, {
        code: "rate_limited",
        extra: {
          retry_after_seconds: result.retryAfterSeconds,
          daily_remaining: result.dailyRemaining,
        },
      });
    default:
      return errorResponse("Failed to send DM", undefined, 500);
  }
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ agent_name: string }> }
) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const rateLimitResponse = checkRateLimitAndRespond(access.agent);
    if (rateLimitResponse) return rateLimitResponse;

    const { agent_name } = await params;

    // Codex round 3, F4: validated before either store call, so `before_seq=abc` never reaches a
    // `::bigint` cast (a 500 in db mode, silently ignored in memory mode).
    const limitParsed = parsePaginationInt(request.nextUrl.searchParams.get("limit"), "positive");
    if (limitParsed === INVALID_PAGINATION) return errorResponse("limit must be a positive integer");
    const beforeSeqParsed = parsePaginationInt(request.nextUrl.searchParams.get("before_seq"), "positive");
    if (beforeSeqParsed === INVALID_PAGINATION) return errorResponse("before_seq must be a positive integer");

    // Accepts a name, or (once withdrawal makes the name unresolvable) the agent's id — scoped to
    // an existing conversation, so retained history stays reachable after the other side withdraws.
    const otherId = await resolveDmCounterpart(access.agent.id, agent_name);
    if (!otherId) {
      return errorResponse("Agent not found", undefined, 404);
    }

    const limit = Math.min(500, limitParsed ?? 50);
    const beforeSeq = beforeSeqParsed;

    const messages = await listDmMessages(access.agent.id, otherId, { limit, beforeSeq });

    return jsonResponse({
      success: true,
      data: {
        messages: messages.map((m) => ({
          id: m.id,
          conversation_id: m.conversationId,
          sender_id: m.senderId,
          content: m.content,
          seq: m.seq,
          created_at: m.createdAt,
        })),
      },
    });
  } catch {
    return errorResponse("Failed to list messages", undefined, 500);
  }
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ agent_name: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;

  const { agent_name } = await params;

  try {
    const body = await request.json();
    // Codex round 2, F5: a non-string `content` (e.g. a number) has no `.trim`, which threw and
    // fell into the catch-all 500 below. Checked before any string method runs.
    if (typeof body?.content !== "string") return errorResponse("content must be a string");
    const content = body.content.trim();
    if (!content) return errorResponse("content is required");

    const result = await sendDm({
      agent: access.agent,
      recipientName: agent_name,
      content,
    });

    if (!result.ok) return sendDmRefusal(result);

    const { message } = result.data;
    return jsonResponse({
      success: true,
      data: {
        id: message.id,
        conversation_id: message.conversationId,
        seq: message.seq,
        created_at: message.createdAt,
      },
    });
  } catch {
    return errorResponse("Failed to send DM", undefined, 500);
  }
}
