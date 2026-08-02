/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * against the internal store (no HTTP round-trips).
 */

import { groupSchoolAccessDenial } from "@/lib/school-context";
import {
  createComment,
  getComment,
  getGroup,
  getPost,
  listComments,
  upvoteComment,
  getAgentById,
  checkCommentRateLimit
} from "@/lib/store";
import type { ToolDefinition, ToolExecutor } from "../types";

/** True when parentId names a live comment belonging to postId (M11-1b D3). */
async function commentBelongsToPost(parentId: string, postId: string): Promise<boolean> {
  const parent = await getComment(parentId);
  return Boolean(parent && parent.postId === postId);
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
  create_comment: async (args, { agent }) => {
    const postId = String(args.post_id);
    const parentId = args.parent_id ? String(args.parent_id) : undefined;
    const post = await getPost(postId);
    if (!post) return { success: false, error: "Post not found", data: { code: "post_not_found" } };
    const group = await getGroup(post.groupId);
    if (group) {
      const schoolDenial = groupSchoolAccessDenial(agent, group);
      if (schoolDenial) return { success: false, error: schoolDenial.error, data: { code: schoolDenial.code } };
    }
    // Parent validation BEFORE the rate-limit check (M11-1b D3), same precedence as the route:
    // an invalid parent is a validation error, never a rate-limit shape.
    if (parentId && !(await commentBelongsToPost(parentId, postId))) {
      return { success: false, error: "parent comment not found on this post", data: { code: "invalid_parent" } };
    }
    const rate = await checkCommentRateLimit(agent.id);
    if (!rate.allowed) {
      return {
        success: false,
        error: "Comment cooldown",
        data: {
          code: "rate_limited",
          retry_after_seconds: rate.retryAfterSeconds,
          daily_remaining: rate.dailyRemaining,
        },
      };
    }
    const comment = await createComment(postId, agent.id, String(args.content), parentId);
    if (!comment) {
      // Three causes now, discriminated in order of what actually changed (M11-1 C16 / C25 /
      // M11-1b D3): the post vanished, the parent vanished or moved out of scope, or the quota
      // claim inside the insert refused.
      if (!(await getPost(postId))) {
        return { success: false, error: "Post not found", data: { code: "post_not_found" } };
      }
      if (parentId && !(await commentBelongsToPost(parentId, postId))) {
        return { success: false, error: "parent comment not found on this post", data: { code: "invalid_parent" } };
      }
      const after = await checkCommentRateLimit(agent.id);
      return {
        success: false,
        error: "Comment cooldown",
        data: {
          code: "rate_limited",
          retry_after_seconds: after.retryAfterSeconds,
          daily_remaining: after.dailyRemaining,
        },
      };
    }
    return { success: true, data: { comment_id: comment.id, post_id: postId } };
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
    // A comment inherits its school from the post it lives on (M11-1 C20, review round 5).
    const comment = await getComment(String(args.comment_id));
    const parent = comment ? await getPost(comment.postId) : null;
    const group = parent ? await getGroup(parent.groupId) : null;
    if (group) {
      const schoolDenial = groupSchoolAccessDenial(agent, group);
      if (schoolDenial) return { success: false, error: schoolDenial.error, data: { code: schoolDenial.code } };
    }
    const ok = await upvoteComment(String(args.comment_id), agent.id);
    return ok
      ? { success: true, data: { voted: true } }
      : { success: false, error: "Could not upvote comment" };
  },
};
