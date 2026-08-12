/**
 * M11-2 P2.1 — a platform chunk's metadata is canonical and STABLE.
 *
 * Driven against the REAL normalizer rather than mocked call arguments, because the two defects
 * this closes both live inside it:
 *
 *  - `upsertVectorChunkBatchForAgent` normalizes every chunk's metadata before storing it, so a
 *    consumer that described its raw pre-normalization input would describe a row nobody writes,
 *    and the shadow soak would mismatch on every ingest effect;
 *  - the normalizer's `filed_at` default is `new Date().toISOString()`, freshly evaluated per call,
 *    so a replay or a second concurrent drain would overwrite the same deterministic chunk id with
 *    a DIFFERENT payload — "idempotent under the natural key" being false for one field.
 *
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

import { buildCommentIngestChunks, buildPostIngestChunks } from "@/lib/memory/platform-ingest";
import { PLATFORM_METADATA_SOURCE, normalizeMemoryMetadata } from "@/lib/memory/metadata";
import type { StoredComment, StoredPost } from "@/lib/store-types";

const BODY = "A body long enough to survive the memory chunker's fifty-character minimum length.";

const post: StoredPost = {
  id: "post_1",
  title: "Hello",
  content: BODY,
  authorId: "agent_1",
  groupId: "group_1",
  upvotes: 0,
  downvotes: 0,
  commentCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
} as StoredPost;

const comment: StoredComment = {
  id: "comment_1",
  postId: post.id,
  authorId: "agent_2",
  content: BODY,
  upvotes: 0,
  createdAt: "2026-01-02T00:00:00.000Z",
} as StoredComment;

describe("platform chunk metadata", () => {
  it("is already normalized, so the vector writer's own pass is a fixpoint", () => {
    for (const chunk of [...buildPostIngestChunks(post), ...buildCommentIngestChunks(comment, post)]) {
      // Exactly what `upsertVectorChunkBatchForAgent` does before storing the chunk.
      const stored = normalizeMemoryMetadata(chunk.metadata, { source: PLATFORM_METADATA_SOURCE });
      expect(stored).toEqual(chunk.metadata);
    }
  });

  it("stamps the SUBJECT's timestamp, not the clock", () => {
    expect(buildPostIngestChunks(post)[0].metadata).toMatchObject({
      source: PLATFORM_METADATA_SOURCE,
      filed_at: post.createdAt,
      kind: "platform_post",
      post_id: post.id,
      author_id: post.authorId,
      source_ref: post.id,
    });
    expect(buildCommentIngestChunks(comment, post)[0].metadata).toMatchObject({
      source: PLATFORM_METADATA_SOURCE,
      filed_at: comment.createdAt,
      kind: "platform_comment",
      post_id: post.id,
      comment_id: comment.id,
      author_id: comment.authorId,
      source_ref: comment.id,
    });
  });

  it("builds byte-identical metadata on a rebuild, so a replay overwrites with the same payload", async () => {
    const first = buildPostIngestChunks(post);
    // A real gap in wall-clock time. A `filed_at` taken from the clock would differ here, and the
    // same chunk id would then carry two different payloads across a replay.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const second = buildPostIngestChunks(post);
    expect(second).toEqual(first);
  });
});
