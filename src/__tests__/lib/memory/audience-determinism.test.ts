/**
 * M11-2 P2.1 — the ingest audience is a function of the DATA, not of the plan.
 *
 * `collectAgentIdsForPostAudience` truncates at `MEMORY_INGEST_MAX_FANOUT`, so the ORDER of the
 * sequence decides who is dropped. Any wobble — a different scan order from Postgres, a different
 * JSONB array order after a membership edit, a different `Map` iteration order — silently changes
 * WHICH recipients are ingested. Two passes over one event would then produce different effect-key
 * sets, the shadow soak would report mismatches that are nobody's defect, and the fan-out would
 * never converge on the same audience twice.
 *
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

import {
  collectAgentIdsForCommentAudience,
  collectAgentIdsForPostAudience,
} from "@/lib/memory/platform-ingest";
import type { StoredComment, StoredPost } from "@/lib/store-types";

const post = {
  id: "post_1",
  title: "Hello",
  content: "Body",
  authorId: "agent_author",
  groupId: "group_1",
  upvotes: 0,
  downvotes: 0,
  commentCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
} as StoredPost;

const comment = {
  id: "comment_1",
  postId: post.id,
  authorId: "agent_commenter",
  content: "Nice",
  upvotes: 0,
  createdAt: "2026-01-02T00:00:00.000Z",
} as StoredComment;

async function seed(memberIds: string[], followerIds: string[]) {
  const memory = await import("@/lib/store/_memory-state");
  memory.resetGroupState();
  memory.following.clear();
  memory.groups.set(post.groupId, {
    id: post.groupId,
    name: "g",
    displayName: "G",
    description: "",
    ownerId: post.authorId,
    memberIds,
    moderatorIds: [],
    pinnedPostIds: [],
    createdAt: post.createdAt,
    type: "group",
  } as never);
  for (const followerId of followerIds) {
    memory.following.set(followerId, new Set([post.authorId]));
  }
}

describe("ingest audience determinism", () => {
  const members = ["m_charlie", "m_alpha", "m_bravo"];
  const followers = ["f_zulu", "f_delta", "f_kilo"];

  it("returns the same sequence on every call for one fixture", async () => {
    await seed(members, followers);
    const first = await collectAgentIdsForPostAudience(post);
    const second = await collectAgentIdsForPostAudience(post);
    expect(second).toEqual(first);
    expect(await collectAgentIdsForCommentAudience(comment, post)).toEqual(
      await collectAgentIdsForCommentAudience(comment, post)
    );
  });

  it("puts the author first, then members by id, then followers by id", async () => {
    await seed(members, followers);
    // The author can never be dropped by the cap — it is their own content — and the two sorted
    // groups after them are what makes the truncation point stable.
    expect(await collectAgentIdsForPostAudience(post)).toEqual([
      post.authorId,
      "m_alpha",
      "m_bravo",
      "m_charlie",
      "f_delta",
      "f_kilo",
      "f_zulu",
    ]);
  });

  it("is unchanged when the underlying sources are enumerated in a different order", async () => {
    await seed(members, followers);
    const canonical = await collectAgentIdsForPostAudience(post);

    // Same data, different insertion order — exactly what a different query plan or a membership
    // edit produces. The audience must not move.
    await seed([...members].reverse(), [...followers].reverse());
    expect(await collectAgentIdsForPostAudience(post)).toEqual(canonical);
  });

  it("survives the cap: the truncated set is the same across calls", async () => {
    const many = Array.from({ length: 40 }, (_, i) => `m_${String(i).padStart(3, "0")}`);
    await seed([...many].reverse(), followers);
    const saved = process.env.MEMORY_INGEST_MAX_FANOUT;
    process.env.MEMORY_INGEST_MAX_FANOUT = "5";
    try {
      const capped = await collectAgentIdsForPostAudience(post);
      expect(capped).toHaveLength(5);
      expect(await collectAgentIdsForPostAudience(post)).toEqual(capped);
      // And it is the FIRST five of the stable order, not five arbitrary members.
      expect(capped).toEqual([post.authorId, "m_000", "m_001", "m_002", "m_003"]);
    } finally {
      if (saved === undefined) delete process.env.MEMORY_INGEST_MAX_FANOUT;
      else process.env.MEMORY_INGEST_MAX_FANOUT = saved;
    }
  });
});
