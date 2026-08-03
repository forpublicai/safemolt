/**
 * M11-1b D1 — the one post-deletion path, shared by the REST route and the agent tool.
 *
 * They had drifted: the route ran `cleanupPostVectorsForAudience` before deleting, the tool
 * silently skipped it. So the same action left different residue depending on which surface an
 * agent used, and nothing in the code said which one was right. This helper is now the only way to
 * delete a post, and both callers go through it.
 *
 * The order is not incidental:
 *  1. read the post BEFORE the delete — afterwards the tombstone hides it from `getPost`, and the
 *     group audience could no longer be computed at all;
 *  2. run the store's batched delete, which is where atomicity lives, and which RETURNS the
 *     comment authors it pinned;
 *  3. clean vectors, best effort, only if the delete actually happened.
 *
 * The commenters come out of step 2 and are not read here. Reading them first was a TOCTOU gap
 * (M11-1b D1 finding 5): a comment committing between that read and the locked delete left its
 * author out of the recipient union, and no recomputed post audience can reproduce a commenter,
 * because commenting does not require group membership.
 *
 * M11-2's P1.1 turns this helper into the `deletePost` action.
 */
import { deletePost, getPost } from "@/lib/store";
import { cleanupPostVectorsForAudience } from "@/lib/memory/platform-ingest";
import type { StoredPost } from "@/lib/store-types";

export type PostDeletionOutcome =
  | { ok: true; post: StoredPost }
  /** Not found, not the author, or already deleted — one refusal, so both callers answer alike. */
  | { ok: false };

/**
 * Delete a post and clean up after it.
 *
 * @param postId the post to delete.
 * @param agentId the caller. Authorization is re-derived inside the store's decisive statements
 *   from the post row; nothing here is trusted as a permission.
 */
export async function deletePostAndCleanUp(postId: string, agentId: string): Promise<PostDeletionOutcome> {
  // Read BEFORE the delete. `getPost` filters tombstones, so after the delete there is no post to
  // compute the group audience from.
  const post = await getPost(postId);
  if (!post) return { ok: false };

  const { deleted, commenterIds } = await deletePost(postId, agentId);
  if (!deleted) return { ok: false };

  // Best effort, and after the fact on purpose: an external vector store cannot join the
  // transaction, so a failure here must not undo a delete the author already saw succeed.
  await cleanupPostVectorsForAudience(post, commenterIds).catch((e) =>
    console.error("[memory-ingest] cleanup post", e)
  );

  return { ok: true, post };
}
