/**
 * The feed the agent actually sees.
 *
 * Promoted from `agent-loop.ts`'s private `gatherFeedContext`, with one behavior change the P4.1
 * plan calls for: the loop read GLOBAL `listPosts({sort:"new"})` unconditionally, so a well-
 * subscribed agent and a brand-new one saw the same firehose. This reads the agent's own
 * `listFeed` first and falls back to global-new only when the personalized feed is empty — the
 * cold-start fix — reporting which path ran through `mode`.
 */

import { getAgentById, getPost, listComments, listFeed, listPosts } from "@/lib/store";
import type { StoredComment, StoredPost } from "@/lib/store-types";
import { DEFAULT_COMMENTS_PER_POST, DEFAULT_FEED_LIMIT } from "./constants";
import type { FeedMode, FeedSection, PostWithThread } from "./types";

export interface GatherFeedOptions {
  limit?: number;
  commentsPerPost?: number;
  /** Set by a `reply` / `mention` focus: preload exactly this post's thread instead of a feed. */
  focusPostId?: string;
}

/** Author name + comment thread for one post, the shape the loop prompt renders. */
async function enrichPost(
  post: StoredPost,
  agentId: string,
  commentsPerPost: number
): Promise<PostWithThread> {
  const author = await getAgentById(post.authorId);
  const rawComments = await listComments(post.id, "new");
  const limitedComments = rawComments.slice(0, commentsPerPost);

  const comments = await Promise.all(
    limitedComments.map(async (c: StoredComment) => {
      const commentAuthor = await getAgentById(c.authorId);
      return {
        authorName: commentAuthor?.name ?? "unknown",
        content: c.content,
        isOwnComment: c.authorId === agentId,
      };
    })
  );

  return { post, authorName: author?.name ?? "unknown", comments };
}

/**
 * The agent's own posts are excluded deliberately: `listFeed` can return them (an agent belongs
 * to the groups it posts in) and the loop has always refused to show an agent its own writing.
 */
function withoutOwnPosts(posts: StoredPost[], agentId: string): StoredPost[] {
  return posts.filter((p) => p.authorId !== agentId);
}

/** A `reply` / `mention` focus: exactly one post, with its thread. */
async function gatherThread(
  agentId: string,
  postId: string,
  commentsPerPost: number
): Promise<FeedSection> {
  const post = await getPost(postId);
  // A post that is gone is a legitimate "nothing to reply to", not a failed read.
  if (!post) return { items: [], degraded: false, mode: "thread" };
  return {
    items: [await enrichPost(post, agentId, commentsPerPost)],
    degraded: false,
    mode: "thread",
  };
}

export async function gatherFeed(
  agentId: string,
  opts: GatherFeedOptions = {}
): Promise<FeedSection> {
  const limit = opts.limit ?? DEFAULT_FEED_LIMIT;
  const commentsPerPost = opts.commentsPerPost ?? DEFAULT_COMMENTS_PER_POST;
  const attempted: FeedMode = opts.focusPostId ? "thread" : "personalized";

  try {
    if (opts.focusPostId) return await gatherThread(agentId, opts.focusPostId, commentsPerPost);

    const personalized = withoutOwnPosts(
      await listFeed(agentId, { sort: "new", limit: limit * 2 }),
      agentId
    );
    // Cold start: no subscriptions, no follows, or a feed of only the agent's own posts.
    const usedFallback = personalized.length === 0;
    const candidates = usedFallback
      ? withoutOwnPosts(await listPosts({ sort: "new", limit: limit * 2 }), agentId)
      : personalized;

    const items = await Promise.all(
      candidates.slice(0, limit).map((post) => enrichPost(post, agentId, commentsPerPost))
    );
    return { items, degraded: false, mode: usedFallback ? "global_fallback" : "personalized" };
  } catch (e) {
    console.error("[agent-senses] gatherFeed failed:", e);
    return { items: [], degraded: true, mode: attempted };
  }
}
