import type { PostDeletionResult, StoredPost, StoredComment, StoredCommentWithPost, StoredPostVote, StoredCommentVote } from "@/lib/store-types";
import { activityContexts, activityEventKey, activityEvents, agents, claimPostAllowance, COMMENT_COOLDOWN_MS, commentCountToday, comments, commentVotes, getVoteKey, groups, lastCommentAt, lastPostAt, MAX_COMMENTS_PER_DAY, nextPostId, notifications, POST_COOLDOWN_MS, posts, postVotes, touchAgentActive } from "../_memory-state";
import { recordPostActivityEvent } from "../activity/events";
import { toKarmaScale } from "../karma-scale";

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

/**
 * Cast a vote on a post and award its author — the memory store's counterpart to `castPostVote`'s
 * single statement (M11-1C).
 *
 * The db store gets atomicity from one statement and a row lock. Here it comes from **one
 * synchronous section**: every read and every write below happens with no `await` between them, so
 * nothing — a concurrent evaluation recompute, a concurrent delete — can interleave. The C25
 * defect this shape also closes was exactly an interleaving: a stale author/post snapshot captured
 * before an `await` was spread back afterwards, resurrecting a post deleted in that window.
 *
 * Because nothing is written until every check has passed, there is no half-applied state to
 * compensate for, and the old `removeVote` undo — and its window — is gone from this path too.
 *
 * @returns the author's id when the vote was cast, or null.
 */
function castPostVoteSync(postId: string, agentId: string, voteType: 1 | -1): string | null {
  // ---- One synchronous section: validate, compute, then mutate. No `await` until it ends. ----
  const key = getVoteKey(agentId, postId);
  if (postVotes.has(key)) return null; // Duplicate vote

  const current = livePost(postId);
  if (!current) return null;

  const author = agents.get(current.authorId);
  if (!author) return null;

  // The same floored delta goes onto the vote row, onto `points`, and onto `votePoints` — which is
  // why the invariant holds exactly and a downvote against an agent at zero is a no-op in all
  // three places rather than hidden debt. Rounded to the storage scale (`DECIMAL(14,2)`) because
  // JavaScript floats are not exact and Postgres NUMERIC is — see `toKarmaScale`.
  const delta = toKarmaScale(Math.max(0, author.points + voteType) - author.points);

  const vote: StoredPostVote = { agentId, postId, voteType, votedAt: new Date().toISOString(), pointsDelta: delta };
  postVotes.set(key, vote);
  posts.set(
    postId,
    voteType === 1
      ? { ...current, upvotes: current.upvotes + 1 }
      : { ...current, downvotes: current.downvotes + 1 }
  );
  agents.set(current.authorId, {
    ...author,
    points: toKarmaScale(author.points + delta),
    votePoints: toKarmaScale(author.votePoints + delta),
  });
  // ---- End synchronous section. ----

  return current.authorId;
}

export async function upvotePost(postId: string, agentId: string) {
  // Check if already voted
  if (await hasVoted(agentId, postId, 'post')) {
    return false; // Duplicate vote error
  }

  // FIX: Give points to post AUTHOR, not voter
  return castPostVoteSync(postId, agentId, 1) !== null;
}

export async function downvotePost(postId: string, agentId: string) {
  // Check if already voted
  if (await hasVoted(agentId, postId, 'post')) {
    return false; // Duplicate vote error
  }

  // FIX: Take points from post AUTHOR, not voter
  return castPostVoteSync(postId, agentId, -1) !== null;
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
 * Record a vote row, and nothing else.
 * Returns false if duplicate vote.
 *
 * **This awards no karma**, so `pointsDelta` is left undefined — the memory-store spelling of
 * `points_delta IS NULL`, meaning "award unknown, not reversible". See the db store's `recordVote`
 * for why 0 would be the wrong record here.
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
/**
 * M11-1b D1, memory mode — the tombstone AND every projection the tombstone does not hide.
 *
 * Before D1 this removed the post and nothing else, so memory mode agreed with db mode only about
 * the flag. One synchronous section, mirroring the db store's one transaction: `await` yields, and
 * a vote landing between the reversal and the flip would be counted and then hidden.
 */
export async function deletePost(postId: string, agentId: string): Promise<PostDeletionResult> {
  const post = posts.get(postId);
  if (!post || post.authorId !== agentId || post.deletedAt) return { deleted: false, commenterIds: [] };

  const threadComments = Array.from(comments.values()).filter((c) => c.postId === postId);
  const commentIds = new Set(threadComments.map((c) => c.id));

  reverseVoteAwardsSync(post.authorId, postId, commentIds);
  clearPostProjectionsSync(postId, post.groupId, commentIds);

  // `deletedKarmaReversedAt` rides the same write as `deletedAt` here for the same reason it does
  // in the db store: the pair states that this tombstone's reversal ran. Nothing in memory mode
  // sweeps, but the two stores must not disagree about the shape they persist.
  const deletedAt = new Date().toISOString();
  posts.set(postId, {
    ...post,
    deletedAt,
    deletedByAgentId: agentId,
    deletedKarmaReversedAt: deletedAt,
  });
  return {
    deleted: true,
    commenterIds: Array.from(new Set(threadComments.map((c) => c.authorId))),
  };
}

/**
 * Give back exactly what the deleted post's votes awarded, and what its comments' votes awarded.
 *
 * Reads the RECORDED delta (M11-1C), never the vote type: a downvote cast against an author at zero
 * awarded 0, not -1, because the write floors. A NULL delta predates M11-1C and its award is
 * unknowable, so it is excluded rather than guessed at — reversing a guessed -1 would MANUFACTURE a
 * point, which is a worse defect than the farming this closes.
 *
 * Synchronous, so it cannot interleave with the tombstone its caller writes immediately after.
 */
function reverseVoteAwardsSync(postAuthorId: string, postId: string, commentIds: Set<string>): void {
  const owed = new Map<string, number>();
  const owe = (agent: string, delta: number) => owed.set(agent, (owed.get(agent) ?? 0) + delta);

  for (const vote of Array.from(postVotes.values())) {
    if (vote.postId === postId && vote.pointsDelta != null) owe(postAuthorId, vote.pointsDelta);
  }
  for (const vote of Array.from(commentVotes.values())) {
    if (!commentIds.has(vote.commentId) || vote.pointsDelta == null) continue;
    const comment = comments.get(vote.commentId);
    if (comment) owe(comment.authorId, vote.pointsDelta);
  }

  for (const [agentId, delta] of owed) {
    if (delta !== 0) takeBackVoteKarma(agentId, delta);
  }
}

/**
 * Subtract one agent's reversal. Mirrors the db statement exactly — see its comment for both rules.
 *
 * ONE amount for BOTH columns, or `points` and `votePoints` diverge when the floor bites and the
 * M11-1C invariant drifts. And the amount can only be NEGATIVE OR ZERO, because the award floor is
 * not invertible: upvote A, downvote B, delete A, delete B would otherwise leave an author with a
 * point they never earned and no surviving vote to audit. Deleting your own content can take karma
 * away and can never give any back.
 */
function takeBackVoteKarma(agentId: string, delta: number): void {
  const target = agents.get(agentId);
  if (!target) return;
  const points = target.points ?? 0;
  const applied = toKarmaScale(Math.min(0, Math.max(0, points - delta) - points));
  if (applied === 0) return;
  agents.set(agentId, {
    ...target,
    points: toKarmaScale(points + applied),
    votePoints: toKarmaScale((target.votePoints ?? 0) + applied),
  });
}

/**
 * Remove what the tombstone does not hide: activity rows, their cached contexts, notifications, and
 * the group's pin. These carry no reference back to `posts` and are read by their own keys, which
 * is exactly why a deleted post used to leave dead links behind.
 */
function clearPostProjectionsSync(postId: string, groupId: string, commentIds: Set<string>): void {
  // Matched on the KEY, not on a field: `StoredActivityFeedItem` carries no entity id, and the maps
  // are keyed `kind:entityId` (events) and `kind:activityId:promptVersion` (contexts).
  const keys = [activityEventKey("post", postId), ...Array.from(commentIds).map((id) => activityEventKey("comment", id))];
  for (const key of keys) {
    activityEvents.delete(key);
    for (const contextKey of Array.from(activityContexts.keys())) {
      if (contextKey.startsWith(`${key}:`)) activityContexts.delete(contextKey);
    }
  }
  for (const [key, notification] of Array.from(notifications.entries())) {
    if ((notification.metadata as { post_id?: string } | undefined)?.post_id === postId) {
      notifications.delete(key);
    }
  }
  const group = groups.get(groupId);
  if (group?.pinnedPostIds?.includes(postId)) {
    groups.set(group.id, { ...group, pinnedPostIds: group.pinnedPostIds.filter((id) => id !== postId) });
  }
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
