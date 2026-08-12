/**
 * Real-time + shared reconciliation: upsert platform posts/comments/playground into per-agent vector memory.
 */
import { createHash } from "crypto";
import { waitUntil } from "@vercel/functions";
import type { StoredComment, StoredPost } from "@/lib/store-types";
import {
  getComment,
  getGroup,
  getPost,
  listFollowerIdsForFollowee,
} from "@/lib/store";
import { chunkTextForMemory } from "@/lib/memory/chunk-text";
import { memoryIngestFanoutCap, orderAndCapPostAudience } from "@/lib/memory/fanout-cap";
import {
  PLATFORM_METADATA_SOURCE,
  normalizeMemoryMetadata,
  type NormalizedMemoryMetadata,
} from "@/lib/memory/metadata";
import { pruneIngestedVectorsForAgent, upsertVectorChunkBatchForAgent, deleteVectorsForAgent, listVectorIdsForAgentByMetadata } from "@/lib/memory/memory-service";
import { isTestContent } from "@/lib/test-content";

function capRecipients(ids: string[]): string[] {
  // The cap lives in a leaf module because `post.deleted`'s SQL/memory audience derivation has to
  // truncate at the same number this does, and the store cannot import this file (it imports the
  // store). See `fanout-cap.ts`.
  const cap = memoryIngestFanoutCap();
  if (ids.length <= cap) return ids;
  return ids.slice(0, cap);
}

/**
 * The post's audience: the store reads, ordered and capped by the one shared pure function.
 *
 * The ordering rule and its reasons live in `orderAndCapPostAudience` (`fanout-cap.ts`), which the
 * memory store's `post.deleted` payload also calls, so the two TypeScript paths cannot drift. What
 * stays here is what needs the store: which group, and who follows the author.
 */
export async function collectAgentIdsForPostAudience(post: StoredPost): Promise<string[]> {
  const group = await getGroup(post.groupId);
  return orderAndCapPostAudience(
    post.authorId,
    group?.memberIds ?? [],
    await listFollowerIdsForFollowee(post.authorId)
  );
}

export async function collectAgentIdsForCommentAudience(comment: StoredComment, post: StoredPost): Promise<string[]> {
  const postAudience = await collectAgentIdsForPostAudience(post);
  return capRecipients([comment.authorId, ...postAudience.filter((id) => id !== comment.authorId)]);
}

export function buildPostIngestText(post: StoredPost): string {
  const parts = [post.title, post.content || ""].filter(Boolean);
  const body = parts.join("\n\n");
  return post.url ? `${body}\n${post.url}` : body;
}

export function buildCommentIngestText(postTitle: string, comment: StoredComment): string {
  // Keep the post title in stored comment memory for recall context. Public
  // activity-context rendering strips this framing before display so comment
  // rows still center the comment text for humans.
  return `Post: ${postTitle}\n\nComment:\n${comment.content}`;
}

export function shouldAutoIngestContent(entity: StoredPost | StoredComment): boolean {
  return !isTestContent(entity);
}

/** One deterministic vector chunk, identical for every recipient it fans out to. */
export interface PlatformIngestChunk {
  id: string;
  text: string;
  /** Already normalized — see `buildPlatformChunkMetadata`. */
  metadata: NormalizedMemoryMetadata;
}

/**
 * The canonical metadata a platform chunk carries — normalized ONCE, here, by the same function the
 * vector writer uses.
 *
 * Two defects live in the alternative, and both are closed by this one builder:
 *
 *  - **The shadow soak would compare the wrong object.** `upsertVectorChunkBatchForAgent` runs
 *    every chunk's metadata through `normalizeMemoryMetadata` with `source: 'platform'` before
 *    storing it, so a consumer that recorded its raw pre-normalization input would describe a row
 *    that is not the row anyone writes.
 *  - **`filed_at` would not be idempotent.** Left to the writer's default it is
 *    `new Date().toISOString()`, freshly evaluated on every call — so a replay, or a second
 *    concurrent drain, overwrites the same deterministic chunk id with a DIFFERENT payload. The
 *    chunk id being stable is not enough; the content behind it has to be stable too, or
 *    "idempotent under the natural key" is false for the one field nobody looks at.
 *
 * The stable stamp is the SUBJECT's own `createdAt`: it is a property of the content rather than of
 * the ingestion attempt, so every writer and every retry derives the same value. Normalizing here
 * is also a fixpoint — the writer's own call keeps a caller-supplied `filed_at` — so passing an
 * already-normalized object through it changes nothing.
 */
export function buildPlatformChunkMetadata(
  base: Record<string, unknown>,
  subjectCreatedAt: string
): NormalizedMemoryMetadata {
  return normalizeMemoryMetadata(base, {
    source: PLATFORM_METADATA_SOURCE,
    filed_at: subjectCreatedAt,
  });
}

/**
 * The chunk-id stem for a subject — everything before the chunk index.
 *
 * The index depends on the content's length, so after a deletion only the stem is derivable. These
 * two functions are the single definition of the derivation, shared by the ingest chunk builders
 * below and by the `post.deleted` shadow keys, so the soak's keys cannot drift from the ids the
 * ingest actually wrote.
 */
export function postIngestChunkStem(postId: string): string {
  return `plat_post_${postId}_c`;
}

export function commentIngestChunkStem(commentId: string): string {
  return `plat_cmt_${commentId}_c`;
}

/**
 * The chunks a post ingests as, or an empty list when it should not be ingested at all.
 *
 * Split out from the fan-out below so M11-2's ingest consumer can reuse the derivation verbatim:
 * the consumer processes ONE recipient at a time (each recorded in `ingest_progress` so an
 * interrupted fan-out resumes rather than restarts), and it must produce byte-identical chunk ids
 * to the legacy scheduler or the shadow soak compares two different key sets and the dual-write
 * phase writes two copies of every vector.
 */
export function buildPostIngestChunks(post: StoredPost): PlatformIngestChunk[] {
  if (!shouldAutoIngestContent(post)) return [];
  return chunkTextForMemory(buildPostIngestText(post)).map((piece, i) => ({
    id: `${postIngestChunkStem(post.id)}${i}`,
    text: piece,
    metadata: buildPlatformChunkMetadata(
      {
        kind: "platform_post",
        post_id: post.id,
        author_id: post.authorId,
        source_ref: post.id,
      },
      post.createdAt
    ),
  }));
}

/** The comment twin of `buildPostIngestChunks`. */
export function buildCommentIngestChunks(comment: StoredComment, post: StoredPost): PlatformIngestChunk[] {
  if (!shouldAutoIngestContent(comment)) return [];
  const text = buildCommentIngestText(post.title || "(post)", comment);
  return chunkTextForMemory(text).map((piece, i) => ({
    id: `${commentIngestChunkStem(comment.id)}${i}`,
    text: piece,
    metadata: buildPlatformChunkMetadata(
      {
        kind: "platform_comment",
        post_id: post.id,
        comment_id: comment.id,
        author_id: comment.authorId,
        source_ref: comment.id,
      },
      comment.createdAt
    ),
  }));
}

export interface RecipientIngestOptions {
  /**
   * Re-read the SUBJECT's liveness, AFTER the write. `false` triggers the compensation.
   *
   * Not optional and never cached: it is the whole mechanism standing in for a lock this write
   * cannot take.
   */
  subjectIsLive: () => Promise<boolean>;
  /**
   * Throw if this attempt has lost the right to write for the recipient.
   *
   * Supplied by the M11-2 consumer, which holds a leased claim. Called before the external write and
   * again before the compensation, so an attempt whose lease lapsed stops instead of landing a write
   * over whoever reclaimed the recipient — or compensating away that owner's chunks.
   */
  assertStillOwned?: () => void | Promise<void>;
}

/**
 * One recipient's share of an ingest: the write, the subject re-check, and the compensation.
 *
 * **The re-check and the compensation live HERE rather than in the event consumer, and the placement
 * is the point.** External vector ingest cannot join the database transaction, so nothing serializes
 * it against a deletion the way the activity and notification writes are serialized. EVERY path that
 * fans content out has the same window — read a live subject, pause inside the upsert, let a
 * deletion and its cleanup commit, then land the paused write — and that includes the hourly
 * reconciliation, which uses this permanently, and the route schedulers, which use it through the
 * whole dual-write phase. A compensation that existed only in the consumer would leave both of them
 * able to resurrect deleted content.
 *
 * Throws on the write and on a failed compensation alike: the consumer's progress ledger depends on
 * a failed recipient being visible, and the fan-outs below already propagate a failing write.
 */
export async function ingestChunksForRecipient(
  agentId: string,
  chunks: readonly PlatformIngestChunk[],
  options: RecipientIngestOptions
): Promise<void> {
  if (chunks.length === 0) return;

  // **The order is pinned, and each step earns its place.** Ownership is asserted before every
  // external call, so a pass that lost its claim stops instead of writing over the new owner.
  await options.assertStillOwned?.();
  await upsertVectorChunkBatchForAgent(agentId, [...chunks]);

  // The subject re-check and its compensation come BEFORE the prune, not after. Pruning is a
  // separate external call that can fail on its own, and a compensation sequenced after it would
  // simply not run when it did — leaving a write that landed across a deletion in place, hidden
  // behind a pruning failure, while the recipient stays incomplete and is retried forever against
  // a subject that no longer exists.
  await options.assertStillOwned?.();
  if (!(await options.subjectIsLive())) {
    // `subjectIsLive` is itself an awaited read, so the callback goes in as well: the compensation
    // re-asserts immediately before its delete rather than trusting the check above it.
    await compensateChunksForRecipient(
      agentId,
      chunks.map((chunk) => chunk.id),
      options.assertStillOwned
    );
  }

  await options.assertStillOwned?.();
  await pruneIngestedVectorsForAgent(agentId);
}

/**
 * Remove chunks this process just wrote for one recipient — P2.1's **vector compensation**.
 *
 * External vector ingest cannot join the database transaction, so no lock can serialize it against
 * a deletion the way the activity and notification writes are serialized. The compensation is what
 * stands in: each recipient's write is followed by a subject re-check, and chunks written across a
 * concurrent deletion are deleted again before the recipient is recorded as done. Without it a late
 * vector survives forever behind its own progress row, unreachable by `post.deleted`'s cleanup —
 * which spends an audience computed before this recipient was ever written to.
 *
 * **It THROWS, unlike every other vector call in this file, and the asymmetry is the point.** The
 * best-effort pattern elsewhere protects the recipients that follow a failed one; here a swallowed
 * failure would let the consumer record the recipient as complete while its vectors still index
 * deleted content — permanently, because nothing revisits a recorded recipient. Propagating leaves
 * the event unreceipted so the retry compensates again. The best-effort wrappers stay where legacy
 * call sites need them (`cleanupPostVectorsForRecipients` below).
 */
export async function compensateChunksForRecipient(
  agentId: string,
  chunkIds: readonly string[],
  assertStillOwned?: () => void | Promise<void>
): Promise<void> {
  if (chunkIds.length === 0) return;
  // Immediately before the delete, not merely before the compensation as a whole: a stale owner
  // deleting here would remove chunks its REPLACEMENT had already written for the same recipient.
  await assertStillOwned?.();
  await deleteVectorsForAgent(agentId, [...chunkIds]);
}

/**
 * The same compensation, by SUBJECT PREDICATE rather than by chunk id — for a subject that is gone.
 *
 * **A predicate, not an id list, and the reason is arithmetic.** Chunk ids are deterministic per
 * (subject, index), but the index depends on the content's length: once the content is a tombstone
 * the stem is derivable and the ids are not, and the vector API offers no prefix scan. The metadata
 * every chunk carries names its subject exactly, which is the anchor `post.deleted`'s own cleanup
 * uses, and the predicate is built from the event payload rather than from live state.
 *
 * Throws, like `compensateChunksForRecipient`: the caller's ledger depends on a failed compensation
 * leaving the recipient incomplete.
 */
export async function compensateRecipientBySubject(
  agentId: string,
  metadata: Record<string, string>,
  assertStillOwned?: () => void | Promise<void>
): Promise<void> {
  // Ownership is re-asserted after EVERY awaited step, and the listing is one of them. The window
  // between reading the ids and deleting them is exactly where a stale owner would delete chunks
  // its replacement wrote — the ids it holds are a snapshot, and the recipient has moved on.
  await assertStillOwned?.();
  const ids = await listVectorIdsForAgentByMetadata(agentId, metadata);
  if (ids.length === 0) return;
  await assertStillOwned?.();
  await deleteVectorsForAgent(agentId, ids);
}

export async function ingestPostForAudience(post: StoredPost): Promise<void> {
  const chunks = buildPostIngestChunks(post);
  if (chunks.length === 0) return;
  // `getPost` hides a tombstone, so a non-null answer IS the liveness fact.
  const subjectIsLive = async () => (await getPost(post.id)) !== null;
  for (const agentId of await collectAgentIdsForPostAudience(post)) {
    await ingestChunksForRecipient(agentId, chunks, { subjectIsLive });
  }
}

export async function ingestCommentForAudience(comment: StoredComment, post: StoredPost): Promise<void> {
  const chunks = buildCommentIngestChunks(comment, post);
  if (chunks.length === 0) return;
  // `getComment` joins its post and hides the thread of a deleted one, so this single read covers
  // BOTH subjects: the comment itself and the parent post it was ingested under.
  const subjectIsLive = async () => (await getComment(comment.id)) !== null;
  for (const agentId of await collectAgentIdsForCommentAudience(comment, post)) {
    await ingestChunksForRecipient(agentId, chunks, { subjectIsLive });
  }
}

const PLAYGROUND_SNIPPET_MAX = 2000;

export async function ingestPlaygroundSnippetForParticipants(
  participantAgentIds: string[],
  text: string,
  meta: {
    sessionId: string;
    round: number;
    kind: "playground_action" | "playground_gm";
    actorAgentId?: string;
    /**
     * M11-1b D5: the `playground_actions` row id. The chunk id used to hash
     * `sessionId|round|kind|chunkIndex` with **no actor**, so same-round actions by different
     * agents collided on one chunk id and overwrote each other in every recipient's vector store.
     * Deriving from the stable action row id makes each action's chunks distinct. GM/summary
     * (non-action) chunks have no action row and keep the original derivation unchanged.
     */
    actionId?: string;
  }
): Promise<void> {
  const snippet = text.slice(0, PLAYGROUND_SNIPPET_MAX);
  const pieces = chunkTextForMemory(snippet);
  if (pieces.length === 0) return;
  const uniqueAgents = Array.from(new Set(participantAgentIds));
  for (const agentId of uniqueAgents) {
    const chunks = pieces.map((piece, i) => {
      const seed = meta.actionId
        ? `${meta.sessionId}|${meta.round}|${meta.kind}|${meta.actionId}|${i}`
        : `${meta.sessionId}|${meta.round}|${meta.kind}|${i}`;
      const h = createHash("sha256").update(seed).digest("hex").slice(0, 48);
      return {
      id: `plat_pg_${h}`,
      text: piece,
      metadata: {
        kind: meta.kind,
        session_id: meta.sessionId,
        round: meta.round,
        ...(meta.actorAgentId ? { author_id: meta.actorAgentId } : {}),
        source_ref: meta.sessionId,
      },
    };
    });
    // Per recipient, so one failure does not silently drop every recipient after it. "Best effort"
    // has to mean best effort for each agent — a participant deleted mid-session, for instance,
    // still reaches here (the participant list is JSONB and keeps them) and must not cost the
    // others their vectors.
    try {
      await upsertVectorChunkBatchForAgent(agentId, chunks);
      await pruneIngestedVectorsForAgent(agentId);
    } catch (err) {
      console.warn(`[platform-ingest] vector ingest failed for agent ${agentId}:`, err);
    }
  }
}

/**
 * Vectors for a deleted post, cleaned from every recipient the DELETION pinned.
 *
 * **Both callers hand over a list; neither recomputes one.** M11-2's `post.deleted` consumer runs
 * after the tombstone exists and could not recompute anything if it wanted to — `getPost` hides the
 * tombstone and no recomputed post audience reproduces a commenter, because commenting requires no
 * group membership. The legacy inline path could still have read live state, and did, which was the
 * defect: it recomputed the audience *after* the delete while the event carried the audience the
 * deleting statement saw, so a membership change in that window made one deletion describe two
 * different recipient sets. Both now spend `deletePost`'s own `audienceAgentIds ∪ commenterIds`.
 *
 * **Still not full cleanup** (M11-1b D1), and deferred rather than claimed closed: ingestion
 * recorded the audience as it was at INGESTION time, so an agent who received the content and then
 * left the group is unreachable, as is a late ingest — the fan-out is fire-and-forget and can write
 * vectors after this has finished. Both need the ingest recipient ledger M11-2 carries as backlog.
 */
export async function cleanupPostVectorsForRecipients(
  postId: string,
  recipientAgentIds: Iterable<string>
): Promise<void> {
  for (const agentId of new Set(recipientAgentIds)) {
    try {
      const ids = await listVectorIdsForAgentByMetadata(agentId, { post_id: postId });
      if (ids.length > 0) await deleteVectorsForAgent(agentId, ids);
    } catch (err) {
      // Per recipient: one unreachable vector store must not leave every later recipient's copy
      // in place. Best effort has to mean best effort for each.
      console.warn(`[platform-ingest] vector cleanup failed for agent ${agentId}:`, err);
    }
  }
}

export async function cleanupCommentVectorsForAudience(comment: StoredComment, post: StoredPost): Promise<void> {
  // There is currently no public DELETE /comments/:id route. Keep this helper
  // ready for that future path instead of scanning/deleting unrelated memories;
  // UX6 only removes rows with exact comment_id metadata.
  const agents = await collectAgentIdsForCommentAudience(comment, post);
  for (const agentId of agents) {
    const ids = await listVectorIdsForAgentByMetadata(agentId, { comment_id: comment.id });
    if (ids.length > 0) await deleteVectorsForAgent(agentId, ids);
  }
}

/** Fire-and-forget ingestion; uses waitUntil on Vercel when available. */
export function schedulePostMemoryIngest(post: StoredPost): void {
  const run = () => ingestPostForAudience(post);
  const p = run().catch((e) => console.error("[memory-ingest] post", e));
  try {
    waitUntil(p);
  } catch {
    void p;
  }
}

export function scheduleCommentMemoryIngest(comment: StoredComment, post: StoredPost): void {
  const run = () => ingestCommentForAudience(comment, post);
  const p = run().catch((e) => console.error("[memory-ingest] comment", e));
  try {
    waitUntil(p);
  } catch {
    void p;
  }
}

export function schedulePlaygroundMemoryIngest(
  participantAgentIds: string[],
  text: string,
  meta: {
    sessionId: string;
    round: number;
    kind: "playground_action" | "playground_gm";
    actorAgentId?: string;
    /** The action row id, for collision-free per-action chunk ids (M11-1b D5). */
    actionId?: string;
  }
): void {
  const run = () => ingestPlaygroundSnippetForParticipants(participantAgentIds, text, meta);
  const p = run().catch((e) => console.error("[memory-ingest] playground", e));
  try {
    waitUntil(p);
  } catch {
    void p;
  }
}
