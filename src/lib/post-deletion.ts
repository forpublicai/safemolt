/**
 * M11-1b D1 — the one post-deletion path, shared by the REST route and the agent tool.
 *
 * They had drifted: the route ran the vector cleanup before deleting, the tool silently skipped it.
 * So the same action left different residue depending on which surface an agent used, and nothing in
 * the code said which one was right. This helper is now the only way to delete a post, and both
 * callers go through it.
 *
 * The order is not incidental:
 *  1. read the post BEFORE the delete — afterwards the tombstone hides it from `getPost`, so the
 *     caller's own answer could no longer be built;
 *  2. run the store's batched delete, which is where atomicity lives, and which RETURNS both id
 *     lists it pinned: the comment authors and the post's ingest audience;
 *  3. clean vectors, best effort, only if the delete actually happened.
 *
 * **The whole recipient set comes out of step 2, and nothing here re-derives any of it.** Reading
 * the commenters first was a TOCTOU gap (M11-1b D1 finding 5): a comment committing between that
 * read and the locked delete left its author out of the recipient union, and no recomputed post
 * audience can reproduce a commenter, because commenting does not require group membership. The
 * audience had the mirror-image gap: the cleanup recomputed it from live state *after* the
 * tombstone, so an agent who joined or left the group in that window was cleaned here but not named
 * in `post.deleted` — the same deletion described by two different recipient sets, and the shadow
 * soak comparing one against the other. Both lists are now pinned by the one statement that also
 * builds the event's payload.
 *
 * M11-2's P1.1 makes it the implementation of `actions/posts.deletePost` rather than replacing it:
 * the route and the tool now call the action, the action calls this, and this is still the only
 * place a post is deleted. The `events` parameter it gained is the Decision-2 handoff — the action
 * decides `post.deleted`, this passes it to the store, and the store's decisive element renders it.
 */
import { deletePost, getPost } from "@/lib/store";
import { cleanupPostVectorsForRecipients } from "@/lib/memory/platform-ingest";
import type { PreparedEvent } from "@/lib/events/kinds";
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
 * @param events the prepared `post.deleted` event, which the store gates on its decisive delete.
 *   Omitted by callers that are not agent actions (fixtures, reconciliation) — a store call with no
 *   events renders exactly the pre-M11-2 statement.
 */
export async function deletePostAndCleanUp(
  postId: string,
  agentId: string,
  events?: readonly PreparedEvent[]
): Promise<PostDeletionOutcome> {
  // Read BEFORE the delete. `getPost` filters tombstones, so after the delete there is no post row
  // left to answer the caller with.
  const post = await getPost(postId);
  if (!post) return { ok: false };

  const { deleted, commenterIds, audienceAgentIds } = await deletePost(postId, agentId, events);
  if (!deleted) return { ok: false };

  // Best effort, and after the fact on purpose: an external vector store cannot join the
  // transaction, so a failure here must not undo a delete the author already saw succeed.
  //
  // The recipients are the deletion's OWN pinned lists — the same union `post.deleted`'s consumer
  // spends (`audience_agent_ids` ∪ `commenter_ids`) — never a fresh audience read.
  await cleanupPostVectorsForRecipients(postId, [...audienceAgentIds, ...commenterIds]).catch((e) =>
    console.error("[memory-ingest] cleanup post", e)
  );

  return { ok: true, post };
}
