/**
 * M11-2 u3 — the deletion path spends the audience the STORE pinned, and never reads a new one.
 *
 * The store builds `post.deleted`'s `audience_agent_ids` inside the deleting statement and returns
 * the same list. This helper used to throw that away and recompute an audience from live state
 * *after* the tombstone, which agrees with the pinned list in any quiet test and diverges exactly
 * when a membership change lands in the window — one deletion, two recipient sets, with the shadow
 * soak comparing one against the other. It is the same recompute M11-1b D1 already forbids for the
 * commenters, and the only shape that holds is to spend what the statement saw.
 *
 * The store and the vector service are both stubbed, because the property under test is precisely
 * that the returned lists are the ONLY input: the fixture's live membership deliberately differs
 * from what the store returns, so a recomputing implementation cleans the wrong agents.
 *
 * @jest-environment node
 */
const storeDeletePost = jest.fn();
const getGroup = jest.fn(async () => ({ id: "grp", memberIds: ["live_member"] }));
const listFollowerIdsForFollowee = jest.fn(async () => ["live_follower"]);

jest.mock("@/lib/store", () => ({
  getPost: jest.fn(async () => ({
    id: "post_1",
    title: "doomed",
    authorId: "author",
    groupId: "grp",
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
  })),
  deletePost: (...args: unknown[]) => storeDeletePost(...args),
  getComment: jest.fn(async () => null),
  getGroup: (...args: unknown[]) => getGroup(...(args as [])),
  listFollowerIdsForFollowee: (...args: unknown[]) => listFollowerIdsForFollowee(...(args as [])),
}));

jest.mock("@/lib/memory/memory-service", () => ({
  upsertVectorChunkBatchForAgent: jest.fn(async () => {}),
  pruneIngestedVectorsForAgent: jest.fn(async () => {}),
  listVectorIdsForAgentByMetadata: jest.fn(async () => [] as string[]),
  deleteVectorsForAgent: jest.fn(async () => {}),
}));

import { listVectorIdsForAgentByMetadata } from "@/lib/memory/memory-service";
import { deletePostAndCleanUp } from "@/lib/post-deletion";

const listVectors = listVectorIdsForAgentByMetadata as jest.Mock;

it("cleans the recipients the deletion returned, and reads no fresh audience", async () => {
  storeDeletePost.mockResolvedValue({
    deleted: true,
    commenterIds: ["pinned_commenter"],
    audienceAgentIds: ["author", "pinned_member"],
  });
  listVectors.mockClear();

  expect(await deletePostAndCleanUp("post_1", "author")).toMatchObject({ ok: true });

  expect(listVectors.mock.calls.map(([agentId]: [string]) => agentId).sort()).toEqual([
    "author",
    "pinned_commenter",
    "pinned_member",
  ]);
  // The live group and the live followers are what a recompute would have reached for. Nobody does.
  expect(getGroup).not.toHaveBeenCalled();
  expect(listFollowerIdsForFollowee).not.toHaveBeenCalled();
});

it("cleans nothing when the store refused the deletion", async () => {
  storeDeletePost.mockResolvedValue({ deleted: false, commenterIds: [], audienceAgentIds: [] });
  listVectors.mockClear();

  expect(await deletePostAndCleanUp("post_1", "author")).toEqual({ ok: false });
  expect(listVectors).not.toHaveBeenCalled();
});
