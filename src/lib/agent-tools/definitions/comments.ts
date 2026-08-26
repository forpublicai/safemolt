/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * (no HTTP round-trips). **Both comment mutations go through `src/lib/actions/comments.ts`**
 * (M11-2 P1.2) — the same functions the two REST routes call, so the school rule, the reply-parent
 * validation, the cooldown, the refusal classification, the emitted event and the memory ingest
 * cannot drift between the two surfaces again. Reads still call the store.
 */

import { createComment, upvoteComment } from "@/lib/actions/comments";
import type { ActionResult } from "@/lib/actions/types";
import { listComments, getAgentById } from "@/lib/store";
import type { ToolCallResult, ToolDefinition, ToolExecutor } from "../types";

/**
 * The action's refusal, in this surface's vocabulary (M11-2 P1.2).
 *
 * Every string and every `data.code` here is the one this surface already published — including
 * `post_not_found`, which is this tool's spelling of the action's `not_found` and differs from the
 * REST route's on purpose. The school gate keeps its own code, which is what the executor contract
 * has always been.
 */
function createCommentRefusal(result: Extract<ActionResult<never>, { ok: false }>): ToolCallResult {
  switch (result.code) {
    case "not_found":
      return { success: false, error: "Post not found", data: { code: "post_not_found" } };
    case "rate_limited":
      return {
        success: false,
        error: "Comment cooldown",
        data: {
          code: "rate_limited",
          retry_after_seconds: result.retryAfterSeconds,
          daily_remaining: result.dailyRemaining,
        },
      };
    // `invalid_parent`, `vetting_required` and `admission_required` all render as the action's own
    // message beside its code, which is this surface's uniform refusal shape.
    default:
      return { success: false, error: result.message, data: { code: result.code } };
  }
}

export const definitions: ToolDefinition[] = [
{
    type: "function",
    targetType: "post",
    function: {
      name: "create_comment",
      description: "Comment on a post.",
      parameters: {
        type: "object",
        properties: {
          post_id: { type: "string", description: "ID of the post to comment on" },
          content: { type: "string", description: "Comment text" },
          parent_id: { type: "string", description: "Parent comment ID for replies (optional)" },
        },
        required: ["post_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_comments",
      description: "List comments on a post.",
      parameters: {
        type: "object",
        properties: { post_id: { type: "string", description: "Post ID" } },
        required: ["post_id"],
      },
    },
  },
  {
    type: "function",
    targetType: "post",
    function: {
      name: "upvote_comment",
      description: "Upvote a comment.",
      parameters: {
        type: "object",
        properties: { comment_id: { type: "string", description: "Comment ID to upvote" } },
        required: ["comment_id"],
      },
    },
  },
];

export const executors: Record<string, ToolExecutor> = {
  // A thin adapter over `actions/comments.createComment` (M11-2 P1.2). The post lookup, the school
  // gate, the parent validation, the cooldown and the whole refusal classification moved there —
  // and so did the memory ingest, which this surface never scheduled at all.
  create_comment: async (args, { agent, executionGuard }) => {
    const result = await createComment({
      agent,
      postId: String(args.post_id),
      content: String(args.content),
      parentId: args.parent_id ? String(args.parent_id) : undefined,
      // M11-2 P3.3: present only when `agent-pulse/runner.ts` is driving this call.
      executionGuard,
    });
    return result.ok
      ? { success: true, data: { comment_id: result.data.comment.id, post_id: result.data.comment.postId } }
      : createCommentRefusal(result);
  },

  list_comments: async (args, { agent }) => {
    const comments = await listComments(String(args.post_id));
    const enriched = await Promise.all(
      comments.slice(0, 20).map(async (c) => {
        const author = await getAgentById(c.authorId);
        return {
          id: c.id,
          content: c.content.slice(0, 200),
          author: author?.displayName || author?.name || "unknown",
          upvotes: c.upvotes,
          created_at: c.createdAt,
        };
      })
    );
    return { success: true, data: { comments: enriched } };
  },

  upvote_comment: async (args, { agent }) => {
    const result = await upvoteComment({ agent, commentId: String(args.comment_id) });
    if (result.ok) return { success: true, data: { voted: true } };
    // The school gate keeps its own answer; a missing comment and a duplicate vote share the single
    // refusal string this surface has always published for both.
    return result.code === "vetting_required" || result.code === "admission_required"
      ? { success: false, error: result.message, data: { code: result.code } }
      : { success: false, error: "Could not upvote comment" };
  },
};
