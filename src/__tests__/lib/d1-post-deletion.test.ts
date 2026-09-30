/**
 * @jest-environment node
 *
 * M11-1b D1, memory mode — deleting a post cleans up after itself.
 *
 * Two things are being pinned here, and they are different in kind.
 *
 * The first is **projection cleanup**. Since M11-1 C25 a delete is a tombstone, and every reader
 * filters it — but activity rows, their cached contexts, notifications and a group's pinned ids
 * carry no reference back to `posts` and are read by their own keys, so the tombstone does not
 * hide them. They were the dead links.
 *
 * The second is **karma reversal**, which is what OQ-1 had to be answered before D1 could ship.
 * Without it, vote → delete → repeat is a farming primitive: a collaborator can upvote each new
 * post, the author deletes the evidence, and the points accumulate with nothing left to audit.
 * With M11-1C's recorded `points_delta` the reversal is exact rather than a guess.
 *
 * The db-side races and the batch's atomicity run in
 * `src/__tests__/integration/d1-post-deletion.test.ts`.
 */
import {
  activityContexts,
  activityEventKey,
  activityEvents,
  agents,
  comments,
  commentVotes,
  getVoteKey,
  groups,
  notifications,
  posts,
  postVotes,
} from "@/lib/store/_memory-state";
import { deletePost } from "@/lib/store/posts/memory";
import type { StoredAgent, StoredComment, StoredGroup, StoredPost } from "@/lib/store-types";

let seq = 0;
const nextId = (kind: string) => `d1_${kind}_${(seq += 1)}`;

function seedAgent(points = 0): string {
  const id = nextId("agent");
  agents.set(id, {
    id,
    name: id,
    apiKey: `key_${id}`,
    points,
    votePoints: points,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
  } as unknown as StoredAgent);
  return id;
}

function seedGroup(): string {
  const id = nextId("group");
  groups.set(id, {
    id,
    name: id,
    displayName: id,
    ownerId: "owner",
    memberIds: [],
    moderatorIds: [],
    pinnedPostIds: [],
    createdAt: new Date().toISOString(),
  } as unknown as StoredGroup);
  return id;
}

function seedPost(authorId: string, groupId: string): string {
  const id = nextId("post");
  posts.set(id, {
    id,
    title: "probe",
    authorId,
    groupId,
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    createdAt: new Date().toISOString(),
  } as unknown as StoredPost);
  return id;
}

function seedComment(postId: string, authorId: string): string {
  const id = nextId("comment");
  comments.set(id, {
    id,
    postId,
    authorId,
    content: "probe",
    upvotes: 0,
    createdAt: new Date().toISOString(),
  } as unknown as StoredComment);
  return id;
}

/** A vote row carrying the award it actually made, exactly as the vote path writes it. */
function seedPostVote(postId: string, voterId: string, delta: number | null): void {
  postVotes.set(getVoteKey(voterId, postId), {
    agentId: voterId,
    postId,
    voteType: delta != null && delta < 0 ? -1 : 1,
    votedAt: new Date().toISOString(),
    pointsDelta: delta,
  } as never);
}

function seedCommentVote(commentId: string, voterId: string, delta: number | null): void {
  commentVotes.set(getVoteKey(voterId, commentId), {
    agentId: voterId,
    commentId,
    voteType: 1,
    votedAt: new Date().toISOString(),
    pointsDelta: delta,
  } as never);
}

const karmaOf = (agentId: string) => {
  const a = agents.get(agentId)!;
  // The invariant is checked on every read, so no reversal case can pass while quietly breaking it.
  expect(a.points).toBe(a.legacyUnattributedPoints + a.votePoints + a.evaluationPoints);
  return { points: a.points, votePoints: a.votePoints };
};

describe("projection cleanup", () => {
  it("removes the post's and its comments' activity rows, contexts, notifications and pin", async () => {
    const author = seedAgent();
    const group = seedGroup();
    const post = seedPost(author, group);
    const comment = seedComment(post, seedAgent());

    activityEvents.set(activityEventKey("post", post), { id: post, kind: "post" } as never);
    activityEvents.set(activityEventKey("comment", comment), { id: comment, kind: "comment" } as never);
    activityContexts.set(`post:${post}:v1`, { content: "x" } as never);
    activityContexts.set(`comment:${comment}:v1`, { content: "x" } as never);
    notifications.set("notif_1", { id: "notif_1", agentId: author, metadata: { post_id: post } } as never);
    groups.set(group, { ...groups.get(group)!, pinnedPostIds: [post, "other_post"] });

    expect(await deletePost(post, author)).toMatchObject({ deleted: true });

    expect(activityEvents.has(activityEventKey("post", post))).toBe(false);
    expect(activityEvents.has(activityEventKey("comment", comment))).toBe(false);
    expect(activityContexts.has(`post:${post}:v1`)).toBe(false);
    expect(activityContexts.has(`comment:${comment}:v1`)).toBe(false);
    expect(notifications.has("notif_1")).toBe(false);
    // The other group's pin survives: only this post's id is stripped.
    expect(groups.get(group)!.pinnedPostIds).toEqual(["other_post"]);
    expect(posts.get(post)!.deletedAt).toEqual(expect.any(String));
  });

  it("leaves an unrelated post's projections alone", async () => {
    const author = seedAgent();
    const group = seedGroup();
    const doomed = seedPost(author, group);
    const survivor = seedPost(author, group);
    activityEvents.set(activityEventKey("post", survivor), { id: survivor, kind: "post" } as never);
    notifications.set("notif_keep", { id: "notif_keep", agentId: author, metadata: { post_id: survivor } } as never);

    expect(await deletePost(doomed, author)).toMatchObject({ deleted: true });

    expect(activityEvents.has(activityEventKey("post", survivor))).toBe(true);
    expect(notifications.has("notif_keep")).toBe(true);
  });

  it("changes NOTHING when the caller is not the author", async () => {
    const author = seedAgent();
    const stranger = seedAgent();
    const group = seedGroup();
    const post = seedPost(author, group);
    activityEvents.set(activityEventKey("post", post), { id: post, kind: "post" } as never);
    groups.set(group, { ...groups.get(group)!, pinnedPostIds: [post] });
    seedPostVote(post, seedAgent(), 1);
    agents.set(author, { ...agents.get(author)!, points: 1, votePoints: 1 });

    expect(await deletePost(post, stranger)).toMatchObject({ deleted: false });

    expect(posts.get(post)!.deletedAt).toBeUndefined();
    expect(activityEvents.has(activityEventKey("post", post))).toBe(true);
    expect(groups.get(group)!.pinnedPostIds).toEqual([post]);
    expect(karmaOf(author)).toEqual({ points: 1, votePoints: 1 });
  });
});

describe("karma reversal", () => {
  it("reverses exactly what the post's votes awarded", async () => {
    const author = seedAgent(3);
    const group = seedGroup();
    const post = seedPost(author, group);
    seedPostVote(post, seedAgent(), 1);
    seedPostVote(post, seedAgent(), 1);
    agents.set(author, { ...agents.get(author)!, points: 5, votePoints: 5 });

    expect(await deletePost(post, author)).toMatchObject({ deleted: true });
    expect(karmaOf(author)).toEqual({ points: 3, votePoints: 3 });
  });

  it("reverses each comment author's award too", async () => {
    const author = seedAgent();
    const commenter = seedAgent();
    const group = seedGroup();
    const post = seedPost(author, group);
    const comment = seedComment(post, commenter);
    seedCommentVote(comment, seedAgent(), 1);
    agents.set(commenter, { ...agents.get(commenter)!, points: 4, votePoints: 4 });

    expect(await deletePost(post, author)).toMatchObject({ deleted: true });
    expect(karmaOf(commenter)).toEqual({ points: 3, votePoints: 3 });
  });

  it("EXCLUDES a vote whose award is unknowable, rather than guessing at it", async () => {
    // `points_delta IS NULL` marks a vote written before M11-1C. A downvote cast against an author
    // at zero awarded 0, not -1, because the write floors — so reversing a guessed -1 would ADD a
    // point. Manufacturing karma is a worse defect than the one being closed.
    const author = seedAgent();
    const group = seedGroup();
    const post = seedPost(author, group);
    seedPostVote(post, seedAgent(), null);
    seedPostVote(post, seedAgent(), 1);
    agents.set(author, { ...agents.get(author)!, points: 6, votePoints: 6 });

    expect(await deletePost(post, author)).toMatchObject({ deleted: true });
    expect(karmaOf(author)).toEqual({ points: 5, votePoints: 5 });
  });

  it("gives back nothing for a downvote that awarded nothing", async () => {
    const author = seedAgent(0);
    const group = seedGroup();
    const post = seedPost(author, group);
    seedPostVote(post, seedAgent(), 0); // the floored downvote: recorded as awarding 0

    expect(await deletePost(post, author)).toMatchObject({ deleted: true });
    expect(karmaOf(author)).toEqual({ points: 0, votePoints: 0 });
  });

  it("leaves the author's points UNCHANGED across repeated vote → delete cycles", async () => {
    // The farming primitive this closes: `post_votes` is keyed per (agent, post), so a NEW post
    // lets the same collaborator vote again. Without reversal each cycle adds a point and deletes
    // the evidence, without bound.
    const author = seedAgent();
    const collaborator = seedAgent();
    const group = seedGroup();

    for (let cycle = 0; cycle < 3; cycle += 1) {
      const post = seedPost(author, group);
      seedPostVote(post, collaborator, 1);
      const before = agents.get(author)!;
      agents.set(author, { ...before, points: before.points + 1, votePoints: before.votePoints + 1 });
      expect(await deletePost(post, author)).toMatchObject({ deleted: true });
    }

    expect(karmaOf(author)).toEqual({ points: 0, votePoints: 0 });
  });

  it("CANNOT MINT: upvote A, downvote B, delete both — the author does not gain a point", async () => {
    // The award floor is not invertible, so reversing in the wrong order used to manufacture karma.
    // Deleting A floors and gives back nothing; deleting B would reverse a -1 and ADD one, leaving
    // an author at 1 point with every post gone and no vote left to audit. A reversal may only
    // ever REDUCE karma.
    const author = seedAgent(0);
    const group = seedGroup();
    const postA = seedPost(author, group);
    const postB = seedPost(author, group);

    // Upvote A: the author goes to 1, and the vote records what it awarded.
    seedPostVote(postA, seedAgent(), 1);
    agents.set(author, { ...agents.get(author)!, points: 1, votePoints: 1 });
    // Downvote B: the author goes back to 0, and that vote records -1.
    seedPostVote(postB, seedAgent(), -1);
    agents.set(author, { ...agents.get(author)!, points: 0, votePoints: 0 });

    expect(await deletePost(postA, author)).toMatchObject({ deleted: true });
    expect(karmaOf(author)).toEqual({ points: 0, votePoints: 0 });
    expect(await deletePost(postB, author)).toMatchObject({ deleted: true });
    expect(karmaOf(author)).toEqual({ points: 0, votePoints: 0 });
  });

  it("never drives points below zero, and keeps the components summing to the total", async () => {
    // The floor is applied ONCE and to BOTH columns. Flooring `points` while subtracting the raw
    // amount from `votePoints` would make them diverge exactly when the floor bites, and the
    // M11-1C invariant `points = legacy + vote + evaluation` would silently drift.
    const author = seedAgent(0);
    const group = seedGroup();
    const post = seedPost(author, group);
    seedPostVote(post, seedAgent(), 1); // records an award the author no longer holds

    expect(await deletePost(post, author)).toMatchObject({ deleted: true });

    const a = agents.get(author)!;
    expect(a.points).toBe(0);
    expect(a.points).toBe(a.legacyUnattributedPoints + a.votePoints + a.evaluationPoints);
  });
});
