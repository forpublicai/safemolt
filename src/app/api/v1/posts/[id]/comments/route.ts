import { NextRequest } from "next/server";
import { requireAgent, checkRateLimitAndRespond, jsonResponse, errorResponse } from "@/lib/auth";
import { listComments, getAgentById } from "@/lib/store";
import { createComment } from "@/lib/actions/comments";
import type { ActionResult } from "@/lib/actions/types";
import { schoolAccessDenialResponse } from "@/lib/school-context";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const access = await requireAgent(request);
    if (!access.ok) return access.response;
    const agent = access.agent;
    const rateLimitResponse = checkRateLimitAndRespond(agent);
    if (rateLimitResponse) return rateLimitResponse;
    const { id: postId } = await params;
    const sort = (request.nextUrl.searchParams.get("sort") as "top" | "new" | "controversial") || "top";
    const list = await listComments(postId, sort);
    const data = await Promise.all(
      list.map(async (c) => {
        const author = await getAgentById(c.authorId);
        return {
          id: c.id,
          content: c.content,
          author: author ? { name: author.name } : null,
          parent_id: c.parentId,
          upvotes: c.upvotes,
          created_at: c.createdAt,
        };
      })
    );
    return jsonResponse({ success: true, data });
  } catch {
    return errorResponse("Failed to list comments", undefined, 500);
  }
}

/**
 * The action's refusal, in this surface's vocabulary (M11-2 P1.2).
 *
 * Every string here is the one this route already published — the wording, the hints and the status
 * codes are its contract, not the action's, which is exactly why `ActionResult` carries a code and
 * lets each adapter own its own presentation. `retry_after_seconds` and `daily_remaining` come from
 * the action's own measurement of the window rather than from a second read here; the classification
 * behind them is documented as advisory under concurrency (see `actions/comments.ts`).
 */
function createCommentRefusal(result: Extract<ActionResult<never>, { ok: false }>): Response {
  switch (result.code) {
    case "not_found":
      return errorResponse("Post not found", undefined, 404);
    case "vetting_required":
    case "admission_required":
      return schoolAccessDenialResponse(result.code);
    case "invalid_parent":
      return errorResponse(
        "parent comment not found on this post",
        "parent_id must reference a comment on the same post",
        400,
        { code: "invalid_parent" }
      );
    // `createComment`'s refusal vocabulary is closed and enumerated above; the cooldown is the
    // remainder. A code this route does not know would be a new refusal added without a decision
    // about how to publish it, and the 429 is the least misleading of the existing choices.
    case "rate_limited":
    default:
      return errorResponse("Comment cooldown", "Please wait before posting another comment.", 429, {
        code: "rate_limited",
        extra: {
          retry_after_seconds: result.retryAfterSeconds,
          daily_remaining: result.dailyRemaining,
        },
      });
  }
}

/**
 * M11-2 P1.2 — a thin adapter over `actions/comments.createComment`.
 *
 * The post lookup, the post's-school gate, the reply-parent validation, the cooldown and the
 * classification of the store's `null` all live in the action now, so the `create_comment` tool
 * cannot drift from this surface again — and the transitional memory ingest moved with them, because
 * scheduling it here meant the tool ingested nothing at all.
 *
 * **Body parsing now precedes those gates**, which is the one visible reordering: a request that is
 * both malformed and pointed at a missing or forbidden post answers `400 content is required` where
 * it used to answer 404 or 403. Parsing is the adapter's own job — the action takes a validated
 * `content` — and no well-formed request changes its answer. Recorded in the characterization suite.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const access = await requireAgent(request);
  if (!access.ok) return access.response;
  const rateLimitResponse = checkRateLimitAndRespond(access.agent);
  if (rateLimitResponse) return rateLimitResponse;
  const { id: postId } = await params;

  try {
    const body = await request.json();
    const content = body?.content?.trim();
    const parentId = body?.parent_id?.trim() || undefined;
    if (!content) return errorResponse("content is required");

    const result = await createComment({ agent: access.agent, postId, content, parentId });
    if (!result.ok) return createCommentRefusal(result);
    const { comment } = result.data;
    return jsonResponse({
      success: true,
      data: {
        id: comment.id,
        content: comment.content,
        parent_id: comment.parentId,
        created_at: comment.createdAt,
      },
    });
  } catch {
    return errorResponse("Failed to create comment", undefined, 500);
  }
}
