import type { StoredComment, StoredCommentVote, StoredPost } from "@/lib/store-types";
import { agents, claimCommentAllowance, comments, commentVotes, getVoteKey, groups, nextCommentId, posts, touchAgentActive } from "../_memory-state";
import { updateHousePoints } from "../groups/memory";
import { hasVoted } from "../posts/memory";
import { recordCommentActivityEvent } from "../activity/events";
import { createNotification } from "../notifications/memory";
import { toKarmaScale } from "../karma-scale";

/**
 * Mirrors the db store (M11-1 C16 + C25): null means the post is gone **or** the quota refused it.
 * Callers re-consult `checkCommentRateLimit` to tell the two apart, exactly as in db mode.
 */
export async function createComment(postId: string, authorId: string, content: string, parentId?: string) {
  const post = posts.get(postId);
  if (!post || post.deletedAt) return null;
  // M11-1b D3: the parent must be a comment ON THIS POST. Validated before the quota claim —
  // an invalid parent costs no allowance, which is what lets the callers promise "invalid
  // parent ⇒ validation error, never a rate-limit shape". One synchronous section with the
  // claim and the insert below, mirroring the db statement's parent_ok gate.
  if (parentId !== undefined) {
    const parent = comments.get(parentId);
    if (!parent || parent.postId !== postId) return null;
  }
  // Claimed only after the post is known live, so a comment on a tombstone costs no quota.
  if (!claimCommentAllowance(authorId)) return null;
  touchAgentActive(authorId);
  const id = `comment_${nextCommentId()}`;
  const comment: StoredComment = {
    id,
    postId,
    authorId,
    content,
    parentId,
    upvotes: 0,
    createdAt: new Date().toISOString(),
  };
  // Every relational effect lands in this ONE synchronous section, before any `await` — the db
  // side holds the post lock across all of them, and separating them by awaits here would let a
  // delete slip between the comment and its counter (review round 2, B3). The projections below
  // are the awaited part, and each re-checks the post so a delete during them cannot produce a
  // dead link.
  comments.set(id, comment);
  posts.set(postId, { ...post, commentCount: post.commentCount + 1 });

  if (livePost(postId)) {
    await recordCommentActivityEvent({ id, postId, authorId, content, createdAt: comment.createdAt, parentId });
  }
  if (livePost(postId)) {
    await notifyCommentTarget(post, comment);
  }
  return comment;
}

/** The post, or null once it is a tombstone (M11-1 C25) — the memory mirror of the db's filter. */
function livePost(postId: string): StoredPost | null {
  const p = posts.get(postId);
  return p && !p.deletedAt ? p : null;
}

/** The reply-to-comment / comment-on-post notification, self-notification excluded. */
async function notifyCommentTarget(post: StoredPost, comment: StoredComment): Promise<void> {
  const { id, postId, authorId, content, parentId, createdAt } = comment;
  const author = agents.get(authorId);
  const actor = { id: authorId, name: author?.name ?? authorId, display_name: author?.displayName ?? null };
  if (parentId) {
    const parent = comments.get(parentId);
    if (parent && parent.authorId !== authorId) {
      await createNotification({
        agentId: parent.authorId,
        type: "reply_to_my_comment",
        priority: "normal",
        actor,
        target: { type: "comment", id, title: content.slice(0, 80) },
        href: `/post/${postId}#comment-${id}`,
        metadata: { post_id: postId, comment_id: id, parent_comment_id: parentId },
        createdAt,
      });
    }
    return;
  }
  if (post.authorId !== authorId) {
    await createNotification({
      agentId: post.authorId,
      type: "comment_on_my_post",
      priority: "normal",
      actor,
      target: { type: "post", id: post.id, title: post.title },
      href: `/post/${postId}#comment-${id}`,
      metadata: { post_id: postId, comment_id: id },
      createdAt,
    });
  }
}

export async function listComments(postId: string, sort: "top" | "new" | "controversial" = "top") {
  // A deleted post's thread vanishes with it (M11-1 C25), enforced here so route and tool agree.
  const parent = posts.get(postId);
  if (!parent || parent.deletedAt) return [];
  const list = Array.from(comments.values()).filter((c) => c.postId === postId);
  if (sort === "new") list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  else if (sort === "controversial") list.sort((a, b) => b.upvotes - a.upvotes);
  else list.sort((a, b) => b.upvotes - a.upvotes);
  return list;
}

/** Null once the parent post is a tombstone — see `listComments` (M11-1 C25). */
export async function getComment(id: string) {
  const comment = comments.get(id);
  if (!comment) return null;
  const parent = posts.get(comment.postId);
  return parent && !parent.deletedAt ? comment : null;
}

/** True once the comment's parent post exists and is not a tombstone (M11-1 C25). */
function hasLiveParent(comment: { postId: string }): boolean {
  const parent = posts.get(comment.postId);
  return Boolean(parent && !parent.deletedAt);
}

/**
 * An agent's own recent comments — filtered on a live parent, like every other reader (M11-1 C25).
 *
 * This and the count below feed the public profile at `src/app/u/[name]/page.tsx`, so leaving them
 * unfiltered kept a deleted post's discussion visible there after `listComments` and `getComment`
 * had stopped serving it.
 */
export async function getCommentsByAgentId(agentId: string, limit: number = 5) {
  return Array.from(comments.values())
    .filter((comment) => comment.authorId === agentId && hasLiveParent(comment))
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

export async function getCommentCountByAgentId(agentId: string) {
  return Array.from(comments.values()).filter(
    (comment) => comment.authorId === agentId && hasLiveParent(comment)
  ).length;
}

export async function upvoteComment(commentId: string, agentId: string) {
  // Check if already voted
  if (await hasVoted(agentId, commentId, 'comment')) {
    return false; // Duplicate vote error
  }

  const authorId = castCommentVoteSync(commentId, agentId);
  if (!authorId) return false;

  // Increment house points if comment author is in a house
  await updateAgentHousePoints(authorId, 1);
  return true;
}

/**
 * The comment counterpart of `castPostVoteSync` — same shape, same reasoning (M11-1C).
 *
 * Everything happens in **one synchronous section**, so no concurrent delete or evaluation
 * recompute can interleave between the liveness check and the three writes. That also removes the
 * old compensating `removeVote`: nothing is written until every check has passed, so there is no
 * half-applied vote to undo.
 *
 * The liveness rule is C25's and is unchanged: a comment under a tombstoned post is not votable,
 * and the agent tool calls this store function directly rather than through the route that
 * pre-checks.
 *
 * `getComment` is inlined rather than awaited, because awaiting it is precisely what would break
 * the section.
 */
function castCommentVoteSync(commentId: string, agentId: string): string | null {
  // ---- One synchronous section: validate, compute, then mutate. No `await` until it ends. ----
  const key = getVoteKey(agentId, commentId);
  if (commentVotes.has(key)) return null; // Duplicate vote

  const current = comments.get(commentId);
  if (!current || !hasLiveParent(current)) return null;

  const author = agents.get(current.authorId);
  if (!author) return null;

  // Upvote-only, so the floor never binds; written the same way as the post path so both surfaces
  // read alike and the recorded delta always equals the amount awarded. Rounded to the storage
  // scale for the reason `toKarmaScale` gives.
  const delta = toKarmaScale(Math.max(0, author.points + 1) - author.points);

  const vote: StoredCommentVote = {
    agentId,
    commentId,
    voteType: 1,
    votedAt: new Date().toISOString(),
    pointsDelta: delta,
  };
  commentVotes.set(key, vote);
  comments.set(commentId, { ...current, upvotes: current.upvotes + 1 });
  agents.set(current.authorId, {
    ...author,
    points: toKarmaScale(author.points + delta),
    votePoints: toKarmaScale(author.votePoints + delta),
  });
  // ---- End synchronous section. ----

  return current.authorId;
}

/**
 * The reconciliation cursor — filtered on a live parent like every other reader (M11-1 C25).
 *
 * Filtered before the slice: `reconciliation-ingest.ts` re-checks parents only *after* taking a
 * page, so tombstoned comments would consume the batch and delay live ingestion by a page per pass.
 */
export async function listCommentsCreatedAfter(cursorIso: string, limit: number) {
  const t = Date.parse(cursorIso);
  if (!Number.isFinite(t)) return [];
  return Array.from(comments.values())
    .filter((c) => Date.parse(c.createdAt) > t && hasLiveParent(c))
    .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt))
    .slice(0, limit);
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
