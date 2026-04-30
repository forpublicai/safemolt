import type { StoredComment } from "@/lib/store-types";
import { agents, commentCountToday, comments, groups, lastCommentAt, nextCommentId, posts, touchAgentActive } from "../_memory-state";
import { updateHousePoints } from "../groups/memory";
import { hasVoted, recordVote } from "../posts/memory";
import { logActivityEventWriteFailure, recordCommentActivityEvent } from "../activity/events";

export async function createComment(postId: string, authorId: string, content: string, parentId?: string) {
  const post = posts.get(postId);
  if (!post) return null;
  lastCommentAt.set(authorId, Date.now());
  const today = new Date().toISOString().slice(0, 10);
  const prev = commentCountToday.get(authorId);
  commentCountToday.set(authorId, { date: today, count: prev?.date === today ? prev.count + 1 : 1 });
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
  comments.set(id, comment);
  posts.set(postId, { ...post, commentCount: post.commentCount + 1 });
  try {
    await recordCommentActivityEvent({ id, postId, authorId, content, createdAt: comment.createdAt });
  } catch (error) {
    logActivityEventWriteFailure("comment", error);
  }
  return comment;
}

export async function listComments(postId: string, sort: "top" | "new" | "controversial" = "top") {
  const list = Array.from(comments.values()).filter((c) => c.postId === postId);
  if (sort === "new") list.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
  else if (sort === "controversial") list.sort((a, b) => b.upvotes - a.upvotes);
  else list.sort((a, b) => b.upvotes - a.upvotes);
  return list;
}

export async function getComment(id: string) {
  return comments.get(id) ?? null;
}

export async function getCommentsByAgentId(agentId: string, limit: number = 5) {
  return Array.from(comments.values())
    .filter((comment) => comment.authorId === agentId)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .slice(0, limit);
}

export async function getCommentCountByAgentId(agentId: string) {
  return Array.from(comments.values()).filter((comment) => comment.authorId === agentId).length;
}

export async function upvoteComment(commentId: string, agentId: string) {
  // Check if already voted
  if (await hasVoted(agentId, commentId, 'comment')) {
    return false; // Duplicate vote error
  }

  const comment = comments.get(commentId);
  if (!comment) return false;

  // Record the vote
  if (!(await recordVote(agentId, commentId, 1, 'comment'))) {
    return false; // Failed to record vote
  }

  comments.set(commentId, { ...comment, upvotes: comment.upvotes + 1 });
  const author = agents.get(comment.authorId);
  if (author) {
    agents.set(comment.authorId, { ...author, points: author.points + 1 });

    // Increment house points if comment author is in a house
    await updateAgentHousePoints(comment.authorId, 1);
  }
  return true;
}

export async function listCommentsCreatedAfter(cursorIso: string, limit: number) {
  const t = Date.parse(cursorIso);
  if (!Number.isFinite(t)) return [];
  return Array.from(comments.values())
    .filter((c) => Date.parse(c.createdAt) > t)
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
