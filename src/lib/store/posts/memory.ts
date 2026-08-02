import type { StoredPost, StoredComment, StoredCommentWithPost, StoredPostVote, StoredCommentVote } from "@/lib/store-types";
import { agents, claimPostAllowance, COMMENT_COOLDOWN_MS, commentCountToday, comments, commentVotes, getVoteKey, groups, lastCommentAt, lastPostAt, MAX_COMMENTS_PER_DAY, nextPostId, POST_COOLDOWN_MS, posts, postVotes, touchAgentActive } from "../_memory-state";
import { updateHousePoints } from "../groups/memory";
import { recordPostActivityEvent } from "../activity/events";

export async function checkPostRateLimit(agentId: string) {
  const last = lastPostAt.get(agentId);
  if (!last) return { allowed: true };
  const elapsed = Date.now() - last;
  if (elapsed >= POST_COOLDOWN_MS) return { allowed: true };
  return { allowed: false, retryAfterMinutes: Math.ceil((POST_COOLDOWN_MS - elapsed) / 60000) };
}

export async function checkCommentRateLimit(agentId: string) {
  const last = lastCommentAt.get(agentId);
  const today = new Date().toISOString().slice(0, 10);
  const dayState = commentCountToday.get(agentId);
  const dailyCount = dayState?.date === today ? dayState.count : 0;
  if (dailyCount >= MAX_COMMENTS_PER_DAY) return { allowed: false, dailyRemaining: 0 };
  if (!last) return { allowed: true, dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount };
  const elapsed = Date.now() - last;
  if (elapsed >= COMMENT_COOLDOWN_MS) return { allowed: true, dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount };
  return {
    allowed: false,
    retryAfterSeconds: Math.ceil((COMMENT_COOLDOWN_MS - elapsed) / 1000),
    dailyRemaining: MAX_COMMENTS_PER_DAY - dailyCount,
  };
}

/** Mirrors the db store's atomic claim (M11-1 C16): null means the cooldown refused the post. */
export async function createPost(authorId: string, groupId: string, title: string, content?: string, url?: string) {
  if (!claimPostAllowance(authorId)) return null;
  touchAgentActive(authorId);
  const id = `post_${nextPostId()}`;
  const post: StoredPost = {
    id,
    title,
    content,
    url,
    authorId,
    groupId,
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    createdAt: new Date().toISOString(),
  };
  posts.set(id, post);
  await recordPostActivityEvent({ id, authorId, groupId, title, content, url, createdAt: post.createdAt });
  return post;
}

export async function getPost(id: string) {
  return livePost(id);
}

/** Mirrors the db store: tombstones included, for unpin only (M11-1b D2 + M11-1 C25). */
export async function getPostIncludingDeleted(id: string) {
  return posts.get(id) ?? null;
}

export async function listPostsByAuthor(agentId: string, limit: number = 12) {
  return livePosts()
    .filter((p) => p.authorId === agentId)
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}

export async function listPosts(options: { group?: string; sort?: string; limit?: number; schoolId?: string } = {}) {
  let list = livePosts();
  if (options.schoolId) {
    list = list.filter(p => {
      const g = groups.get(p.groupId);
      return g?.schoolId === options.schoolId || (options.schoolId === 'foundation' && !g?.schoolId);
    });
  }
  if (options.group) {
    // Resolve group name to group ID
    const group = Array.from(groups.values()).find(g => g.name.toLowerCase() === options.group!.toLowerCase());
    if (group) {
      list = list.filter((p) => p.groupId === group.id);
    } else {
      // Group not found, return empty array
      return [];
    }
  }
  const sort = options.sort || "new";
  if (sort === "new") list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  else if (sort === "top") list.sort((a, b) => b.upvotes - a.upvotes);
  else if (sort === "hot") list.sort((a, b) => (b.upvotes - b.downvotes) - (a.upvotes - a.downvotes));
  const limit = options.limit ?? 25;
  return list.slice(0, limit);
}

export async function upvotePost(postId: string, agentId: string) {
  // Check if already voted
  if (await hasVoted(agentId, postId, 'post')) {
    return false; // Duplicate vote error
  }

  const post = livePost(postId);
  if (!post) return false;

  // Record the vote
  if (!(await recordVote(agentId, postId, 1, 'post'))) {
    return false; // Failed to record vote
  }

  const author = agents.get(post.authorId);
  if (!author) return false;

  // Re-read after the await. Spreading the snapshot captured *before* `recordVote` would write
  // back a copy without `deletedAt` and resurrect a post deleted in that window (M11-1 C25).
  const current = livePost(postId);
  if (!current) {
    // The vote was already recorded; leaving it would block this agent from ever voting on the
    // target again while awarding it nothing.
    await removeVote(agentId, postId, 'post');
    return false;
  }
  posts.set(postId, { ...current, upvotes: current.upvotes + 1 });
  // FIX: Give points to post AUTHOR, not voter
  agents.set(post.authorId, { ...author, points: author.points + 1 });

  // Increment house points if post author is in a house
  await updateAgentHousePoints(post.authorId, 1);

  return true;
}

export async function downvotePost(postId: string, agentId: string) {
  // Check if already voted
  if (await hasVoted(agentId, postId, 'post')) {
    return false; // Duplicate vote error
  }

  const post = livePost(postId);
  if (!post) return false;

  // Record the vote
  if (!(await recordVote(agentId, postId, -1, 'post'))) {
    return false; // Failed to record vote
  }

  const author = agents.get(post.authorId);
  if (!author) return false;

  // Re-read after the await — see upvotePost (M11-1 C25).
  const current = livePost(postId);
  if (!current) {
    await removeVote(agentId, postId, 'post');
    return false;
  }
  posts.set(postId, { ...current, downvotes: current.downvotes + 1 });
  // FIX: Take points from post AUTHOR, not voter
  agents.set(post.authorId, { ...author, points: Math.max(0, author.points - 1) });

  // Decrement house points if post author is in a house
  await updateAgentHousePoints(post.authorId, -1);

  return true;
}

/**
 * Check if an agent has already voted on a post or comment
 */
export async function hasVoted(
  agentId: string,
  targetId: string,
  type: 'post' | 'comment') {
  const key = getVoteKey(agentId, targetId);
  if (type === 'post') {
    return postVotes.has(key);
  } else {
    return commentVotes.has(key);
  }
}

/**
 * Undo a vote row.
 *
 * Used when the post turned out to be a tombstone after the vote was recorded — leaving the row
 * would block this agent from ever voting on the target again while awarding it nothing
 * (M11-1 C25).
 */
export async function removeVote(agentId: string, targetId: string, type: 'post' | 'comment') {
  const key = getVoteKey(agentId, targetId);
  if (type === 'post') postVotes.delete(key);
  else commentVotes.delete(key);
}

/**
 * Record a vote on a post or comment
 * Returns false if duplicate vote
 */
export async function recordVote(
  agentId: string,
  targetId: string,
  voteType: number,
  type: 'post' | 'comment') {
  const key = getVoteKey(agentId, targetId);
  const votedAt = new Date().toISOString();

  if (type === 'post') {
    if (postVotes.has(key)) return false; // Duplicate vote
    const vote: StoredPostVote = {
      agentId,
      postId: targetId,
      voteType,
      votedAt,
    };
    postVotes.set(key, vote);
  } else {
    if (commentVotes.has(key)) return false; // Duplicate vote
    const vote: StoredCommentVote = {
      agentId,
      commentId: targetId,
      voteType,
      votedAt,
    };
    commentVotes.set(key, vote);
  }
  return true;
}

/**
 * Get a post vote record for a specific agent and post
 * Returns null if no vote exists
 */
export async function getPostVote(agentId: string, postId: string) {
  const key = getVoteKey(agentId, postId);
  return postVotes.get(key) ?? null;
}

/**
 * Get a comment vote record for a specific agent and comment
 * Returns null if no vote exists
 */
export async function getCommentVote(agentId: string, commentId: string) {
  const key = getVoteKey(agentId, commentId);
  return commentVotes.get(key) ?? null;
}

/**
 * Mirror of the db soft delete (M11-1 C25). Nothing is removed, so a comment or vote from another
 * agent can no longer veto the author's deletion, and every read below filters the tombstone.
 */
export async function deletePost(postId: string, agentId: string) {
  const post = posts.get(postId);
  if (!post || post.authorId !== agentId || post.deletedAt) return false;
  posts.set(postId, { ...post, deletedAt: new Date().toISOString(), deletedByAgentId: agentId });
  return true;
}

/** Live posts only — the single place memory-mode reads filter the C25 tombstone. */
export function livePosts(): StoredPost[] {
  return Array.from(posts.values()).filter((p) => !p.deletedAt);
}

/** Live post by id, or null if absent or deleted. */
export function livePost(id: string): StoredPost | null {
  const post = posts.get(id);
  return post && !post.deletedAt ? post : null;
}

export async function listPostsCreatedAfter(cursorIso: string, limit: number) {
  const t = Date.parse(cursorIso);
  if (!Number.isFinite(t)) return [];
  return livePosts()
    .filter((p) => Date.parse(p.createdAt) > t)
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, limit);
}

/**
 * Recent comments across the site — filtered on a live parent (M11-1 C25).
 *
 * Filtered *before* the slice, not after: dropping tombstoned comments afterwards would let them
 * consume slots and silently shorten the activity trail.
 */
export async function listRecentComments(limit = 25) {
  return Array.from(comments.values())
    .filter((c) => Boolean(livePost(c.postId)))
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, limit);
}

export async function listRecentCommentsWithPosts(limit = 25) {
  return (await listRecentComments(limit))
    .map((comment) => {
      const post = livePost(comment.postId);
      return post ? { comment, post } : null;
    })
    .filter((item): item is StoredCommentWithPost => Boolean(item));
}

export async function searchPosts(
  q: string,
  options: { type?: "posts" | "comments" | "all"; limit?: number } = {}) {
  const limit = options.limit ?? 20;
  const lower = q.toLowerCase().trim();
  if (!lower) return [];
  if (options.type === "comments") {
    const list = Array.from(comments.values()).filter((c) => c.content.toLowerCase().includes(lower));
    return list
      .map((c) => ({ type: "comment" as const, comment: c, post: livePost(c.postId)! }))
      .filter((x) => x.post)
      .slice(0, limit);
  }
  const postList = livePosts().filter(
    (p) => (p.title && p.title.toLowerCase().includes(lower)) || (p.content && p.content.toLowerCase().includes(lower))
  );
  if (options.type === "posts") return postList.slice(0, limit).map((post) => ({ type: "post" as const, post }));
  const commentList = Array.from(comments.values()).filter((c) => c.content.toLowerCase().includes(lower));
  const combined: ({ type: "post"; post: StoredPost } | { type: "comment"; comment: StoredComment; post: StoredPost })[] = [
    ...postList.map((post) => ({ type: "post" as const, post })),
    ...commentList.map((c) => ({ type: "comment" as const, comment: c, post: livePost(c.postId)! })).filter((x) => x.post),
  ];
  return combined.slice(0, limit);
}

/** Owner/moderator check read synchronously from the group row (M11-1b D2): no `await` between
 *  the check and the write, so a concurrent pin cannot capture the same pre-write array. */
function isGroupModerator(g: { ownerId: string; moderatorIds: string[] }, agentId: string): boolean {
  return g.ownerId === agentId || g.moderatorIds.includes(agentId);
}

export async function pinPost(groupId: string, postId: string, agentId: string) {
  // One synchronous section mirroring the db's single locked statement: authorize, require a live
  // post in this group, append-if-absent under the 3-pin cap. Already-pinned is idempotent success.
  const g = groups.get(groupId);
  if (!g || !isGroupModerator(g, agentId)) return false;
  const post = livePost(postId);
  if (!post || post.groupId !== groupId) return false;
  const pinned = g.pinnedPostIds ?? [];
  if (pinned.includes(postId)) return true;
  if (pinned.length >= 3) return false;
  groups.set(groupId, { ...g, pinnedPostIds: [...pinned, postId] });
  return true;
}

export async function unpinPost(groupId: string, postId: string, agentId: string) {
  // No live-post requirement (M11-1b D2): a moderator must be able to clear a stale id whose post
  // is already gone. Authorization is checked in the same synchronous section as the removal.
  const g = groups.get(groupId);
  if (!g || !isGroupModerator(g, agentId)) return false;
  const pinned = (g.pinnedPostIds ?? []).filter((id) => id !== postId);
  groups.set(groupId, { ...g, pinnedPostIds: pinned });
  return true;
}

/**
 * Update house points for an agent's house if they are a member.
 * @param agentId - The agent whose house points should be updated
 * @param delta - The point change (+1 for upvote, -1 for downvote)
 */
async function updateAgentHousePoints(agentId: string, delta: number) {
  const house = Array.from(groups.values()).find(
    (group) => group.type === 'house' && group.memberIds.includes(agentId)
  );
  if (house) await updateHousePoints(house.id, delta);
}
