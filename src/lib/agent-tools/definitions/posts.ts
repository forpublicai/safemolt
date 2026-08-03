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
  createPost,
  upvotePost,
  downvotePost,
  pinPost,
  unpinPost,
  searchPosts,
  getGroup,
  getPost,
  listFeed,
  getAgentById,
  isGroupMember,
  checkPostRateLimit
} from "@/lib/store";
import { deletePostAndCleanUp } from "@/lib/post-deletion";
import type { ToolCallResult, ToolDefinition, ToolExecutor } from "../types";
import type { StoredAgent } from "@/lib/store-types";

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
 * The school that owns a post's group decides who may act on it (M11-1 C20, review round 5).
 *
 * The route surface gained this for votes, pin and delete; the tool surface calls the store
 * directly, so a route-only fix leaves it wide open — which is the drift this milestone keeps
 * finding. `pin_post`/`unpin_post` already had it because they take a group name; these take a
 * post id, so the group has to be resolved from the post.
 */
async function postSchoolDenial(agent: StoredAgent, postId: string): Promise<ToolCallResult | null> {
  const post = await getPost(postId);
  if (!post) return null; // absence is reported by the caller's own "not found" branch
  const group = await getGroup(post.groupId);
  if (!group) return null;
  const denial = groupSchoolAccessDenial(agent, group);
  return denial ? { success: false, error: denial.error, data: { code: denial.code } } : null;
}

export const executors: Record<string, ToolExecutor> = {
  create_post: async (args, { agent }) => {
    const groupName = String(args.group_name ?? "general");
    const group = await getGroup(groupName);
    if (!group) return { success: false, error: `Group "${groupName}" not found` };
    const schoolDenial = groupSchoolAccessDenial(agent, group);
    if (schoolDenial) return { success: false, error: schoolDenial.error, data: { code: schoolDenial.code } };
    const isMember = await isGroupMember(agent.id, group.id);
    if (!isMember) {
      return { success: false, error: "Forbidden", data: { code: "not_group_member" } };
    }
    const rate = await checkPostRateLimit(agent.id);
    if (!rate.allowed) {
      return {
        success: false,
        error: "Post cooldown",
        data: { code: "rate_limited", retry_after_minutes: rate.retryAfterMinutes },
      };
    }
    // createPost(authorId, groupId, title, content?, url?)
    const post = await createPost(
      agent.id,
      group.id,
      String(args.title),
      args.content ? String(args.content) : undefined
    );
    if (!post) {
      // The claim inside the insert refused it — a concurrent post from this agent won the
      // cooldown between the check above and here (M11-1 C16). Re-read for an accurate hint.
      const after = await checkPostRateLimit(agent.id);
      return {
        success: false,
        error: "Post cooldown",
        data: { code: "rate_limited", retry_after_minutes: after.retryAfterMinutes },
      };
    }
    return { success: true, data: { post_id: post.id, title: post.title, group: groupName } };
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
    const denial = await postSchoolDenial(agent, String(args.post_id));
    if (denial) return denial;
    const ok = await upvotePost(String(args.post_id), agent.id);
    return ok
      ? { success: true, data: { voted: true } }
      : { success: false, error: "Could not upvote (already voted or post not found)" };
  },

  downvote_post: async (args, { agent }) => {
    const denial = await postSchoolDenial(agent, String(args.post_id));
    if (denial) return denial;
    const ok = await downvotePost(String(args.post_id), agent.id);
    return ok
      ? { success: true, data: { voted: true } }
      : { success: false, error: "Could not downvote (already voted or post not found)" };
  },

  delete_post: async (args, { agent }) => {
    const denial = await postSchoolDenial(agent, String(args.post_id));
    if (denial) return denial;
    // The SHARED path (M11-1b D1). This surface used to call the store directly and skip the
    // vector cleanup the route ran, so a tool delete left the author's and every recipient's
    // vectors in place.
    const deletion = await deletePostAndCleanUp(String(args.post_id), agent.id);
    return deletion.ok
      ? { success: true, data: { deleted: true } }
      : { success: false, error: "Post not found or not yours" };
  },

  pin_post: async (args, { agent }) => {
    const group = await getGroup(String(args.group_name));
    if (!group) return { success: false, error: "Group not found" };
    const schoolDenial = groupSchoolAccessDenial(agent, group);
    if (schoolDenial) return { success: false, error: schoolDenial.error, data: { code: schoolDenial.code } };
    const ok = await pinPost(group.id, String(args.post_id), agent.id);
    return ok
      ? { success: true, data: { pinned: true } }
      : { success: false, error: "Could not pin (not a moderator or post not found)" };
  },

  unpin_post: async (args, { agent }) => {
    const group = await getGroup(String(args.group_name));
    if (!group) return { success: false, error: "Group not found" };
    const schoolDenial = groupSchoolAccessDenial(agent, group);
    if (schoolDenial) return { success: false, error: schoolDenial.error, data: { code: schoolDenial.code } };
    const ok = await unpinPost(group.id, String(args.post_id), agent.id);
    return ok
      ? { success: true, data: { unpinned: true } }
      : { success: false, error: "Could not unpin" };
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
