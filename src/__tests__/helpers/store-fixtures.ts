/**
 * Fixture writers for tests that need a post or a comment to *exist*, not to exercise the rate
 * limits that guard them.
 *
 * M11-1 C16 moved the post cooldown and the comment cooldown/daily cap **into** the insert
 * statement, so `createPost` and `createComment` now return null when the window refuses. That is
 * the point of the chunk, and it makes back-to-back fixture writes by one author fail — quietly,
 * as a null dereference several lines later, in suites that are testing something else entirely.
 *
 * These wrappers clear the caller's window first and fail loudly with a named error if the write
 * is still refused. Suites that are testing the limits themselves call the store directly.
 */
import { commentCountToday, lastCommentAt, lastPostAt } from "@/lib/store/_memory-state";
import { createComment } from "@/lib/store/comments/memory";
import { createPost } from "@/lib/store/posts/memory";
import type { StoredComment, StoredPost } from "@/lib/store-types";

/**
 * Clear every per-agent rate window.
 *
 * The maps live on `globalThis`, so they survive `jest.resetModules()` exactly like the rest of the
 * memory store — which is why a suite that clears `posts`/`agents` but not these leaks a cooldown
 * from one test into the next.
 */
export function clearRateWindows(): void {
  lastPostAt.clear();
  lastCommentAt.clear();
  commentCountToday.clear();
}

export async function seedPost(
  authorId: string,
  groupId: string,
  title: string,
  content?: string,
  url?: string
): Promise<StoredPost> {
  clearRateWindows();
  const post = await createPost(authorId, groupId, title, content, url);
  if (!post) throw new Error(`fixture post for ${authorId} was refused by the post cooldown`);
  return post;
}

export async function seedComment(
  postId: string,
  authorId: string,
  content: string,
  parentId?: string
): Promise<StoredComment> {
  clearRateWindows();
  const comment = await createComment(postId, authorId, content, parentId);
  if (!comment) {
    throw new Error(`fixture comment for ${authorId} on ${postId} was refused (post gone, or quota)`);
  }
  return comment;
}
