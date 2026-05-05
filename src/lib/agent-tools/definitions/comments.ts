/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * against the internal store (no HTTP round-trips).
 */

import {
  createComment,
  getPost,
  listComments,
  upvoteComment,
  getAgentById
} from "@/lib/store";
import type { ToolDefinition, ToolExecutor } from "../types";

export const definitions: ToolDefinition[] = [
{
    type: "function",
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
    const post = await getPost(postId);
    if (!post) return { success: false, error: "Post not found" };
    const comment = await createComment(
      postId,
      agent.id,
      String(args.content),
      args.parent_id ? String(args.parent_id) : undefined
    );
    if (!comment) return { success: false, error: "Could not create comment" };
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
    const ok = await upvoteComment(String(args.comment_id), agent.id);
    return ok
      ? { success: true, data: { voted: true } }
      : { success: false, error: "Could not upvote comment" };
  },
};
