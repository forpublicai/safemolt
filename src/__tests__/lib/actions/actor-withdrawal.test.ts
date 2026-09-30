/**
 * M11-2 u3b (P1.2), codex round 4 — **the ACTING agent must still exist when the write lands.**
 *
 * Every producer here is reached through an action that awaits at least one read first — the post,
 * its group, the followee's row. A caller that withdraws inside that window used to leave the memory
 * store writing a comment, a vote or a follow owned by an agent that no longer exists: the post
 * counter moved, the author's karma moved, the event was appended, and nothing pointed back at a
 * real actor.
 *
 * **Postgres refuses the same race**, through the actor foreign keys — `comments.author_id`,
 * `post_votes.agent_id`, `comment_votes.agent_id`, `following.follower_id` — each of which fails the
 * whole statement, so nothing is written there either. The end state agrees; what differs is that
 * the db raises where memory refuses, because memory has no constraint to trip and can only decline
 * before writing. Refusing is the parity that matters: both stores end with nothing written, and the
 * alternative for memory is a dangling row that no later sweep would find.
 *
 * Determinism comes from interposing on a read the ACTION awaits, rather than from timing: the store
 * facade's `getGroup` is stubbed to withdraw the caller before it answers, which places the
 * withdrawal squarely inside the window and nowhere else.
 *
 * @jest-environment node
 */
jest.mock("@/lib/store", () => {
  const actual = jest.requireActual("@/lib/store");
  return { ...actual, getGroup: jest.fn(actual.getGroup) };
});

import { createComment, upvoteComment } from "@/lib/actions/comments";
import { downvotePost, upvotePost } from "@/lib/actions/posts";
import * as store from "@/lib/store";
import { comments, commentVotes, eventLog, following, posts, postVotes } from "@/lib/store/_memory-state";
import { createAgent, deleteAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import { clearRateWindows, seedComment, seedPost } from "@/__tests__/helpers/store-fixtures";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

const getGroup = store.getGroup as jest.Mock;
const realGetGroup = jest.requireActual("@/lib/store").getGroup as typeof store.getGroup;

let seq = 0;
const nextName = (label: string) => `u3bw_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

async function agent(label: string): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "u3b withdrawal fixture");
  await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

const marker = () => eventLog.nextId - 1;
const eventsSince = (since: number): StoredEvent[] => eventLog.rows.filter((event) => event.id > since);

/** Withdraw `agentId` the next time the action reads a group — i.e. mid-action, before the write. */
function withdrawDuringGroupRead(agentId: string): void {
  getGroup.mockImplementationOnce(async (name: string) => {
    const group = await realGetGroup(name);
    expect(await deleteAgent(agentId)).toEqual({ ok: true });
    return group;
  });
}

beforeEach(() => {
  clearRateWindows();
  // `mockReset`, not `mockClear`: an unconsumed `mockImplementationOnce` would answer for the next
  // test's read.
  getGroup.mockReset();
  getGroup.mockImplementation(realGetGroup);
});

describe("a caller that withdraws mid-action writes nothing", () => {
  it("refuses the comment, moves no counter and emits nothing", async () => {
    const author = await agent("cauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "subject");
    const commenter = await agent("ccommenter");
    clearRateWindows();
    withdrawDuringGroupRead(commenter.id);
    const before = marker();

    const result = await createComment({ agent: commenter, postId: post.id, content: "orphaned" });

    expect(result.ok).toBe(false);
    expect(Array.from(comments.values()).some((c) => c.authorId === commenter.id)).toBe(false);
    expect(posts.get(post.id)!.commentCount).toBe(0);
    expect(eventsSince(before)).toEqual([]);
  });

  it("refuses the post vote, awards no karma and emits nothing", async () => {
    const author = await agent("vauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "vote subject");
    const voter = await agent("vvoter");
    withdrawDuringGroupRead(voter.id);
    const before = marker();

    const result = await upvotePost({ agent: voter, postId: post.id });

    expect(result.ok).toBe(false);
    expect(postVotes.size).toBe(0);
    expect(posts.get(post.id)!.upvotes).toBe(0);
    expect((await getAgentById(author.id))!.points).toBe(0);
    expect(eventsSince(before)).toEqual([]);
  });

  it("refuses the downvote the same way", async () => {
    const author = await agent("dauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "downvote subject");
    const voter = await agent("dvoter");
    withdrawDuringGroupRead(voter.id);
    const before = marker();

    expect((await downvotePost({ agent: voter, postId: post.id })).ok).toBe(false);
    expect(postVotes.size).toBe(0);
    expect(posts.get(post.id)!.downvotes).toBe(0);
    expect(eventsSince(before)).toEqual([]);
  });

  it("refuses the comment vote, awards no karma and emits nothing", async () => {
    const author = await agent("cvauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "comment vote subject");
    const comment = await seedComment(post.id, author.id, "vote me");
    const voter = await agent("cvvoter");
    withdrawDuringGroupRead(voter.id);
    const before = marker();

    const result = await upvoteComment({ agent: voter, commentId: comment.id });

    expect(result.ok).toBe(false);
    expect(commentVotes.size).toBe(0);
    expect(comments.get(comment.id)!.upvotes).toBe(0);
    expect((await getAgentById(author.id))!.points).toBe(0);
    expect(eventsSince(before)).toEqual([]);
  });
});

/**
 * The follow producer has no group read, so its window is its OWN awaited name resolution — the same
 * one `follow-target-race.test.ts` uses for the followee. Here it is the FOLLOWER that withdraws, so
 * both ids have to be re-checked after that await, not just the subject.
 */
describe("a follower that withdraws during resolution writes nothing", () => {
  it("refuses, leaves no edge and emits nothing", async () => {
    const { followAgent: storeFollowAgent } = await import("@/lib/store/agents/memory");
    const followee = await agent("wfollowee");
    const follower = await agent("wfollower");
    const before = marker();

    // Suspends at `await getAgentByName(...)`; memory `deleteAgent` then runs to completion
    // synchronously, so the withdrawal is guaranteed to land inside the window.
    const pending = storeFollowAgent(follower.id, followee.name, [
      { kind: "agent.followed", actorAgentId: follower.id, subjectType: "agent", payload: {} },
    ]);
    expect(await deleteAgent(follower.id)).toEqual({ ok: true });

    await expect(pending).resolves.toBe(false);
    expect(following.get(follower.id)?.size ?? 0).toBe(0);
    expect((await getAgentById(followee.id))!.followerCount).toBe(0);
    expect(eventsSince(before)).toEqual([]);
  });
});
