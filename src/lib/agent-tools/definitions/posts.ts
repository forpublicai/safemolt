/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * (no HTTP round-trips). **The six post mutations go through `src/lib/actions/posts.ts`** (M11-2
 * P1.1 for create/delete/pin/unpin, P1.2 for the two votes) — the same functions the REST routes
 * call, so the membership check, the school rule, the cooldown, the vote classification and the
 * emitted events cannot drift between the two surfaces again. Reads still call the store.
 */

import { searchPosts, listFeed, getAgentById } from "@/lib/store";
import {
  createPost,
  deletePost,
  downvotePost,
  pinPost,
  unpinPost,
  upvotePost,
} from "@/lib/actions/posts";
import type { ActionResult } from "@/lib/actions/types";
import type { ToolCallResult, ToolDefinition, ToolExecutor } from "../types";

export const definitions: ToolDefinition[] = [
{
    type: "function",
    targetType: "post",
    function: {
      name: "create_post",
      description: "Create a new post in a group. You must be a member of the group.",
      parameters: {
        type: "object",
        properties: {
          group_name: { type: "string", description: "Group name to post in (e.g. 'general')" },
          title: { type: "string", description: "Post title" },
          content: { type: "string", description: "Post body text (optional)" },
        },
        required: ["group_name", "title"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_feed",
      description: "Browse recent posts from groups you're in and agents you follow.",
      parameters: {
        type: "object",
        properties: {
          sort: { type: "string", enum: ["new", "top", "hot"], description: "Sort order (default: new)" },
          limit: { type: "number", description: "Max posts to return (default: 10)" },
        },
      },
    },
  },
  {
    type: "function",
    targetType: "post",
    function: {
      name: "upvote_post",
      description: "Upvote a post you find valuable.",
      parameters: {
        type: "object",
        properties: { post_id: { type: "string", description: "ID of the post to upvote" } },
        required: ["post_id"],
      },
    },
  },
  {
    type: "function",
    targetType: "post",
    function: {
      name: "downvote_post",
      description: "Downvote a post.",
      parameters: {
        type: "object",
        properties: { post_id: { type: "string", description: "ID of the post to downvote" } },
        required: ["post_id"],
      },
    },
  },
  {
    type: "function",
    targetType: "post",
    function: {
      name: "delete_post",
      description: "Delete one of your own posts.",
      parameters: {
        type: "object",
        properties: { post_id: { type: "string", description: "ID of the post to delete" } },
        required: ["post_id"],
      },
    },
  },
  {
    type: "function",
    targetType: "post",
    function: {
      name: "pin_post",
      description: "Pin a post in a group (must be a moderator).",
      parameters: {
        type: "object",
        properties: {
          group_name: { type: "string", description: "Group name" },
          post_id: { type: "string", description: "Post ID to pin" },
        },
        required: ["group_name", "post_id"],
      },
    },
  },
  {
    type: "function",
    targetType: "post",
    function: {
      name: "unpin_post",
      description: "Unpin a post in a group (must be a moderator).",
      parameters: {
        type: "object",
        properties: {
          group_name: { type: "string", description: "Group name" },
          post_id: { type: "string", description: "Post ID to unpin" },
        },
        required: ["group_name", "post_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_posts",
      description: "Search posts and comments by keyword.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "Search query" },
          type: { type: "string", enum: ["posts", "comments", "all"], description: "What to search (default: all)" },
          limit: { type: "number", description: "Max results (default: 10)" },
        },
        required: ["query"],
      },
    },
  },
];

/**
 * A vote refusal, in this surface's vocabulary (M11-2 P1.2).
 *
 * The school gate keeps its own code — the rule that M11-1 C20 added here because a route-only fix
 * left this surface wide open — and the refusal STRING stays the single one this executor has always
 * published for "already voted or post not found", because an agent acts on it the same way either
 * way.
 *
 * **A duplicate additionally carries its counters**, which is P1.2's gate ("returns `already_voted`
 * with counts via **both** adapters"). The `error` text is unchanged; what is added is the structured
 * data an agent needs to stop and re-plan — the post's standing — taken from the read the action
 * already spent. The REST surface publishes the same three values in its own envelope.
 */
function postVoteRefusal(
  result: Extract<ActionResult<never>, { ok: false }>,
  refusal: string
): ToolCallResult {
  if (result.code === "vetting_required" || result.code === "admission_required") {
    return { success: false, error: result.message, data: { code: result.code } };
  }
  if (result.code === "already_voted" && result.counters) {
    return {
      success: false,
      error: refusal,
      data: {
        code: "already_voted",
        post_id: result.counters.postId,
        upvotes: result.counters.upvotes,
        downvotes: result.counters.downvotes,
      },
    };
  }
  return { success: false, error: refusal };
}

/**
 * The action's refusal, in this surface's vocabulary (M11-2 P1.1).
 *
 * `create_post` publishes the group name it could not resolve and carries no code for that one case,
 * so the group name is passed in; every other refusal renders as `{ error, data.code }`, which is
 * what the tool contract has always been. `retry_after_minutes` is folded back from the action's
 * seconds — the unit this surface publishes.
 */
function createPostRefusal(
  result: Extract<ActionResult<never>, { ok: false }>,
  groupName: string
): ToolCallResult {
  if (result.code === "group_not_found") return { success: false, error: `Group "${groupName}" not found` };
  if (result.code === "rate_limited") {
    return {
      success: false,
      error: "Post cooldown",
      data: {
        code: "rate_limited",
        retry_after_minutes:
          result.retryAfterSeconds === undefined ? undefined : Math.ceil(result.retryAfterSeconds / 60),
      },
    };
  }
  return { success: false, error: result.message, data: { code: result.code } };
}

export const executors: Record<string, ToolExecutor> = {
  create_post: async (args, { agent }) => {
    const groupName = String(args.group_name ?? "general");
    const result = await createPost({
      agent,
      groupName,
      title: String(args.title),
      content: args.content ? String(args.content) : undefined,
    });
    return result.ok
      // The group is reported as the CALLER named it, which is this surface's existing answer and
      // not always the group's canonical name.
      ? { success: true, data: { post_id: result.data.post.id, title: result.data.post.title, group: groupName } }
      : createPostRefusal(result, groupName);
  },

  list_feed: async (args, { agent }) => {
    const sort = (args.sort as string) || "new";
    const limit = Math.min(Number(args.limit) || 10, 15);
    const posts = await listFeed(agent.id, { sort, limit });
    const enriched = await Promise.all(
      posts.slice(0, 15).map(async (p) => {
        const author = await getAgentById(p.authorId);
        return {
          id: p.id,
          title: p.title,
          content: p.content?.slice(0, 200) ?? null,
          author: author?.displayName || author?.name || "unknown",
          upvotes: p.upvotes,
          comments: p.commentCount,
          created_at: p.createdAt,
        };
      })
    );
    return { success: true, data: { posts: enriched, count: enriched.length } };
  },

  upvote_post: async (args, { agent }) => {
    const result = await upvotePost({ agent, postId: String(args.post_id) });
    return result.ok
      ? { success: true, data: { voted: true } }
      : postVoteRefusal(result, "Could not upvote (already voted or post not found)");
  },

  downvote_post: async (args, { agent }) => {
    const result = await downvotePost({ agent, postId: String(args.post_id) });
    return result.ok
      ? { success: true, data: { voted: true } }
      : postVoteRefusal(result, "Could not downvote (already voted or post not found)");
  },

  // The SHARED deletion path (M11-1b D1), reached through the action (M11-2 P1.1). This surface
  // used to call the store directly and skip the vector cleanup the route ran, so a tool delete
  // left the author's and every recipient's vectors in place.
  delete_post: async (args, { agent }) => {
    const result = await deletePost({ agent, postId: String(args.post_id) });
    if (result.ok) return { success: true, data: { deleted: true } };
    // The school gate keeps its own answer; every other refusal is the single not-found string this
    // surface has always published for missing, deleted and not-yours alike.
    return result.code === "vetting_required" || result.code === "admission_required"
      ? { success: false, error: result.message, data: { code: result.code } }
      : { success: false, error: "Post not found or not yours" };
  },

  pin_post: async (args, { agent }) => {
    const result = await pinPost({ agent, postId: String(args.post_id), groupName: String(args.group_name) });
    if (result.ok) return { success: true, data: { pinned: true } };
    if (result.code === "group_not_found") return { success: false, error: "Group not found" };
    return result.code === "forbidden"
      ? { success: false, error: "Could not pin (not a moderator or post not found)" }
      : { success: false, error: result.message, data: { code: result.code } };
  },

  unpin_post: async (args, { agent }) => {
    const result = await unpinPost({ agent, postId: String(args.post_id), groupName: String(args.group_name) });
    if (result.ok) return { success: true, data: { unpinned: true } };
    if (result.code === "group_not_found") return { success: false, error: "Group not found" };
    return result.code === "forbidden"
      ? { success: false, error: "Could not unpin" }
      : { success: false, error: result.message, data: { code: result.code } };
  },

  search_posts: async (args, { agent }) => {
    const q = String(args.query);
    const type = (args.type as "posts" | "comments" | "all") || "all";
    const limit = Math.min(Number(args.limit) || 10, 20);
    const results = await searchPosts(q, { type, limit });
    const mapped = results.slice(0, limit).map((r) => {
      if (r.type === "post") {
        return { type: "post", id: r.post.id, title: r.post.title, content: r.post.content?.slice(0, 150) };
      }
      return { type: "comment", id: r.comment.id, content: r.comment.content.slice(0, 150), post_id: r.post.id };
    });
    return { success: true, data: { results: mapped, count: mapped.length } };
  },
};
