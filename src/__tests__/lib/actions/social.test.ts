/**
 * M11-2 u3b (P1.2) — the comment, vote and follow actions in **memory mode**, the mode Jest and
 * local development run.
 *
 * The properties pinned here are the ones the milestone rests on, and each is invisible to the
 * characterization suite because none of them is a wire shape:
 *
 *  1. **Causal coupling in both directions.** Every successful mutation appends exactly its event;
 *     every refused one appends none. Memory mode has no CTE to gate on, so the guarantee comes from
 *     the store performing the mutation and the append in one synchronous section — and the only way
 *     to see that it holds is to drive the real refusals (deleted post, invalid parent, cap
 *     boundary, duplicate vote, re-follow).
 *  2. **The store fills what the action cannot know.** `comment.created`'s `comment_id` is minted
 *     inside the store, and the action writes `STORE_ASSIGNED_PAYLOAD_ID` there rather than `''`,
 *     because an unfilled empty id is *valid* to a consumer and would skip in silence.
 *  3. **The transitional projections carry their correlation.** The trail row stamps
 *     `source_event_id`, and the notification stamps Decision 6's `dedup_key`, from the same event
 *     the mutation emitted — which is what makes the dual-write phase ordered rather than lucky.
 *  4. **The recorded behavior change**: a re-follow writes nothing, emits nothing, and no longer
 *     refreshes the activity trail (P1.2's follow-alignment paragraph).
 *  5. **Memory mode does not block on ingest.** The action returns with its notification and
 *     activity already visible, without awaiting the vector fan-out.
 *
 * @jest-environment node
 */
jest.mock("@/lib/memory/memory-service", () => ({
  upsertVectorChunkBatchForAgent: jest.fn(async () => {}),
  pruneIngestedVectorsForAgent: jest.fn(async () => {}),
  listVectorIdsForAgentByMetadata: jest.fn(async () => [] as string[]),
  deleteVectorsForAgent: jest.fn(async () => {}),
}));

import { createComment, upvoteComment } from "@/lib/actions/comments";
import { followAgent, unfollowAgent } from "@/lib/actions/agents";
import { downvotePost, upvotePost } from "@/lib/actions/posts";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import { MAX_COMMENTS_PER_DAY } from "@/lib/store/rate-limit-windows";
import {
  activityEventKey,
  activityEventSourceIds,
  activityEvents,
  commentCountToday,
  eventLog,
  lastCommentAt,
  notificationDedupKeys,
  notifications,
  posts,
} from "@/lib/store/_memory-state";
import { createAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import { clearRateWindows, seedComment, seedPost } from "@/__tests__/helpers/store-fixtures";
import type { StoredAgent, StoredEvent } from "@/lib/store-types";

let seq = 0;
const nextName = (label: string) => `u3ba_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

async function agent(label: string, options: { vetted?: boolean } = {}): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "u3b action fixture");
  if (options.vetted !== false) await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

const marker = () => eventLog.nextId - 1;
const eventsSince = (since: number): StoredEvent[] => eventLog.rows.filter((event) => event.id > since);

beforeEach(() => {
  clearRateWindows();
});

describe("createComment", () => {
  it("emits one comment.created carrying the id the store minted, with no placeholder left", async () => {
    const author = await agent("author");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "commentable");
    const commenter = await agent("commenter");
    clearRateWindows();
    const before = marker();

    const result = await createComment({ agent: commenter, postId: post.id, content: "hello" });
    expect(result.ok).toBe(true);
    const comment = result.ok ? result.data.comment : null;

    const emitted = eventsSince(before);
    expect(emitted.map((event) => event.kind)).toEqual(["comment.created"]);
    expect(emitted[0].subjectId).toBe(comment!.id);
    expect(emitted[0].secondarySubjectId).toBe(post.id);
    expect(emitted[0].actorAgentId).toBe(commenter.id);
    expect(emitted[0].payload).toEqual({ comment_id: comment!.id, post_id: post.id, parent_id: null });
    // The marker must never survive into a real event: a consumer dead-letters on it, which is the
    // whole reason it is a marker rather than an empty string.
    expect(JSON.stringify(emitted[0])).not.toContain(STORE_ASSIGNED_PAYLOAD_ID);
  });

  it("carries the parent id on a reply, as a present key rather than an absent one", async () => {
    const author = await agent("replyauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "thread");
    const parent = await seedComment(post.id, author.id, "the parent");
    const replier = await agent("replier");
    clearRateWindows();
    const before = marker();

    await createComment({ agent: replier, postId: post.id, content: "a reply", parentId: parent.id });

    const [event] = eventsSince(before);
    expect(event.payload).toMatchObject({ post_id: post.id, parent_id: parent.id });
  });

  /**
   * The two transitional stamps, both from the event the same write emitted.
   *
   * `occurred_at` needs no stamp for this kind and deliberately has none: both writers project the
   * COMMENT's own `created_at`, so they already share one clock — the same reason `post.created`
   * left `OCCURRED_AT_STAMP_PENDING_KINDS` in u3 without one.
   */
  it("stamps the trail row's source event and the notification's dedup key", async () => {
    const author = await agent("stampauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "stamped");
    const commenter = await agent("stampcommenter");
    clearRateWindows();
    const before = marker();

    const result = await createComment({ agent: commenter, postId: post.id, content: "hi there" });
    const comment = result.ok ? result.data.comment : null;
    const [event] = eventsSince(before);

    const key = activityEventKey("comment", comment!.id);
    expect(activityEvents.get(key)?.occurredAt).toBe(comment!.createdAt);
    expect(activityEventSourceIds.get(key)).toBe(event.id);
    // Decision 6: `{type}:{recipient}:{event_id}`, and the recipient is the POST's author.
    expect(notificationDedupKeys.has(`comment_on_my_post:${author.id}:${event.id}`)).toBe(true);
    // Both projections are visible when the action resolves — Decision 6's memory-mode contract.
    expect(
      Array.from(notifications.values()).some(
        (row) => row.agent_id === author.id && row.metadata?.comment_id === comment!.id
      )
    ).toBe(true);
  });

  it("keys a reply's notification on the PARENT comment's author", async () => {
    const author = await agent("noreplyauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "reply thread");
    const parentAuthor = await agent("parentauthor");
    const parent = await seedComment(post.id, parentAuthor.id, "the parent");
    const replier = await agent("replier2");
    clearRateWindows();
    const before = marker();

    await createComment({ agent: replier, postId: post.id, content: "reply", parentId: parent.id });
    const [event] = eventsSince(before);

    expect(notificationDedupKeys.has(`reply_to_my_comment:${parentAuthor.id}:${event.id}`)).toBe(true);
    // A reply notifies the parent's author and NOT the post's — the legacy contract, preserved.
    expect(notificationDedupKeys.has(`comment_on_my_post:${author.id}:${event.id}`)).toBe(false);
  });

  /**
   * The classification order P1.2 pins, and the quota each refusal does NOT charge.
   */
  it("answers not_found for a missing post, charging no quota and emitting nothing", async () => {
    const caller = await agent("missing");
    const before = marker();

    expect(await createComment({ agent: caller, postId: "post_nope", content: "x" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(eventsSince(before)).toEqual([]);
    expect(lastCommentAt.has(caller.id)).toBe(false);
    expect(commentCountToday.has(caller.id)).toBe(false);
  });

  it("answers not_found for a concurrently deleted post, charging no quota", async () => {
    const author = await agent("tombauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "about to go");
    const commenter = await agent("tombcommenter");
    clearRateWindows();
    posts.get(post.id)!.deletedAt = new Date().toISOString();
    const before = marker();

    expect(await createComment({ agent: commenter, postId: post.id, content: "x" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(eventsSince(before)).toEqual([]);
    expect(lastCommentAt.has(commenter.id)).toBe(false);
  });

  it("answers invalid_parent — never a rate-limit shape — and charges no quota", async () => {
    const author = await agent("parentauthor2");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "here");
    const elsewhere = await seedPost(author.id, group.id, "there");
    const foreign = await seedComment(elsewhere.id, author.id, "on another post");
    const replier = await agent("badparent");
    clearRateWindows();
    const before = marker();

    expect(
      await createComment({ agent: replier, postId: post.id, content: "x", parentId: foreign.id })
    ).toMatchObject({ ok: false, code: "invalid_parent" });
    expect(eventsSince(before)).toEqual([]);
    expect(lastCommentAt.has(replier.id)).toBe(false);
  });

  it("answers rate_limited with a measured window, and emits nothing", async () => {
    const author = await agent("capauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "cap subject");
    const commenter = await agent("capcommenter");
    clearRateWindows();

    expect((await createComment({ agent: commenter, postId: post.id, content: "one" })).ok).toBe(true);
    const before = marker();
    const refused = await createComment({ agent: commenter, postId: post.id, content: "two" });

    expect(refused).toMatchObject({ ok: false, code: "rate_limited" });
    expect(refused.ok === false && typeof refused.retryAfterSeconds).toBe("number");
    expect(refused.ok === false && refused.dailyRemaining).toBe(MAX_COMMENTS_PER_DAY - 1);
    expect(eventsSince(before)).toEqual([]);
  });

  it("answers the daily cap with the UTC-midnight retry schedule, and emits nothing", async () => {
    const author = await agent("dcapauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "cap ceiling");
    const commenter = await agent("dcapcommenter");
    clearRateWindows();
    // The cap binds, the cooldown does not — so the schedule below can only be the day boundary's.
    commentCountToday.set(commenter.id, {
      date: new Date().toISOString().slice(0, 10),
      count: MAX_COMMENTS_PER_DAY,
    });
    const before = marker();

    const refused = await createComment({ agent: commenter, postId: post.id, content: "over" });

    expect(refused).toMatchObject({ ok: false, code: "rate_limited" });
    // The cap's schedule is the UTC day boundary (codex u3b round 3): the one refusal an agent
    // cannot shorten had been the one carrying no `retry_after_seconds` at all.
    const retry = refused.ok === false ? refused.retryAfterSeconds : undefined;
    expect(retry).toBeGreaterThan(0);
    expect(retry).toBeLessThanOrEqual(86_400);
    expect(refused.ok === false && refused.dailyRemaining).toBe(0);
    expect(eventsSince(before)).toEqual([]);
  });

  it("emits nothing when the school refuses the commenter", async () => {
    const author = await agent("schoolauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "gated");
    const unvetted = await agent("schoolunvetted", { vetted: false });
    clearRateWindows();
    const before = marker();

    expect(await createComment({ agent: unvetted, postId: post.id, content: "x" })).toMatchObject({
      ok: false,
      code: "vetting_required",
    });
    expect(eventsSince(before)).toEqual([]);
  });

  /**
   * **The refusal order, read off the db store step for step** (codex round 1).
   *
   * The db store's live-post check is a separate `SELECT` that returns before the batch is built, so
   * a malformed event on a dead post never reaches the renderer and both stores answer `null`.
   * Everything after it — the parent, the cap, the cooldown — is decided INSIDE the statement
   * Postgres renders, and rendering is where it validates the event: so an invalid-parent request
   * carrying an unknown kind THROWS, in both stores, rather than being classified first.
   *
   * The store is called directly here because an unknown kind is exactly what no action can produce;
   * the parity being pinned is the store's.
   */
  it("validates the event after the live-post check and before the parent and quota checks", async () => {
    const { createComment: storeCreateComment } = await import("@/lib/store/comments/memory");
    const author = await agent("orderauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "order subject");
    const elsewhere = await seedPost(author.id, group.id, "another");
    const foreign = await seedComment(elsewhere.id, author.id, "on another post");
    const caller = await agent("ordercaller");
    clearRateWindows();
    const malformed = [
      { kind: "not.a.real.kind", actorAgentId: caller.id, subjectType: "comment", payload: {} },
    ] as unknown as PreparedEvent[];

    // Dead post: the db pre-check returns before the render, so this is a refusal, not a throw.
    posts.get(post.id)!.deletedAt = new Date().toISOString();
    await expect(storeCreateComment(post.id, caller.id, "x", undefined, malformed)).resolves.toBeNull();
    delete posts.get(post.id)!.deletedAt;

    // Invalid parent: decided inside the statement, so the render — and the validation — came first.
    await expect(
      storeCreateComment(post.id, caller.id, "x", foreign.id, malformed)
    ).rejects.toThrow(/unknown kind/);

    // Rate-limited: same position in the statement, same answer.
    expect((await createComment({ agent: caller, postId: post.id, content: "one" })).ok).toBe(true);
    await expect(storeCreateComment(post.id, caller.id, "two", undefined, malformed)).rejects.toThrow(
      /unknown kind/
    );
  });

  /**
   * **The memory-mode non-blocking gate (P1.2's own).**
   *
   * `scheduleCommentMemoryIngest` is fire-and-forget on both surfaces, and the action must not have
   * become the place that waits for it: the vector work is sequential and external. The proof is
   * that the action resolves while the vector writer is still parked — and that the two projections
   * the caller *does* depend on are already there when it does.
   */
  it("returns without awaiting the ingest, with its projections already visible", async () => {
    const memoryService = await import("@/lib/memory/memory-service");
    const upsert = memoryService.upsertVectorChunkBatchForAgent as jest.Mock;
    let release: (() => void) | undefined;
    upsert.mockImplementation(() => new Promise<void>((resolve) => { release = () => resolve(); }));

    const author = await agent("ingestauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "ingest subject");
    const commenter = await agent("ingestcommenter");
    clearRateWindows();

    const result = await createComment({
      agent: commenter,
      postId: post.id,
      // Long enough to survive the chunker's fifty-character minimum, so a chunk really is written.
      content: "A comment long enough to survive the memory chunker's minimum chunk length of fifty.",
    });

    // Resolved while the vector call is still outstanding.
    expect(result.ok).toBe(true);
    const comment = result.ok ? result.data.comment : null;
    expect(activityEvents.has(activityEventKey("comment", comment!.id))).toBe(true);
    expect(
      Array.from(notifications.values()).some((row) => row.metadata?.comment_id === comment!.id)
    ).toBe(true);

    release?.();
    upsert.mockImplementation(async () => {});
  });
});

describe("post and comment votes", () => {
  it("emits one post.voted per direction, carrying the direction it took", async () => {
    const author = await agent("voteauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "vote subject");
    const up = await agent("upvoter");
    const down = await agent("downvoter");
    const before = marker();

    const upvoted = await upvotePost({ agent: up, postId: post.id });
    const downvoted = await downvotePost({ agent: down, postId: post.id });

    expect(upvoted.ok && upvoted.data).toMatchObject({ postId: post.id, upvotes: 1, downvotes: 0 });
    expect(downvoted.ok && downvoted.data).toMatchObject({ postId: post.id, upvotes: 1, downvotes: 1 });
    const emitted = eventsSince(before);
    expect(emitted.map((event) => event.kind)).toEqual(["post.voted", "post.voted"]);
    expect(emitted.map((event) => event.payload)).toEqual([
      { post_id: post.id, direction: "up" },
      { post_id: post.id, direction: "down" },
    ]);
    expect(emitted.map((event) => event.actorAgentId)).toEqual([up.id, down.id]);
  });

  it("answers already_voted for a duplicate and writes nothing at all", async () => {
    const author = await agent("dupauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "dup subject");
    const voter = await agent("dupvoter");
    expect((await upvotePost({ agent: voter, postId: post.id })).ok).toBe(true);
    const before = marker();

    const duplicate = await upvotePost({ agent: voter, postId: post.id });

    expect(duplicate).toMatchObject({ ok: false, code: "already_voted" });
    // No zero-delta churn: the counter did not move and no event was appended.
    expect(posts.get(post.id)!.upvotes).toBe(1);
    expect(eventsSince(before)).toEqual([]);
  });

  it("answers not_found — not already_voted — for a tombstoned post", async () => {
    const author = await agent("tombvoteauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "doomed subject");
    const voter = await agent("tombvoter");
    posts.get(post.id)!.deletedAt = new Date().toISOString();
    const before = marker();

    expect(await upvotePost({ agent: voter, postId: post.id })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(eventsSince(before)).toEqual([]);
  });

  it("emits comment.voted with both ids, and answers already_voted for a duplicate", async () => {
    const author = await agent("cvauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "comment vote subject");
    const comment = await seedComment(post.id, author.id, "vote me");
    const voter = await agent("cvvoter");
    const before = marker();

    expect((await upvoteComment({ agent: voter, commentId: comment.id })).ok).toBe(true);
    const emitted = eventsSince(before);
    expect(emitted.map((event) => event.kind)).toEqual(["comment.voted"]);
    expect(emitted[0].payload).toEqual({ comment_id: comment.id, post_id: post.id });

    const after = marker();
    expect(await upvoteComment({ agent: voter, commentId: comment.id })).toMatchObject({
      ok: false,
      code: "already_voted",
    });
    expect(eventsSince(after)).toEqual([]);
  });

  it("emits nothing when the school refuses the voter, on either surface", async () => {
    const author = await agent("voteschoolauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "gated vote");
    const comment = await seedComment(post.id, author.id, "gated comment");
    const unvetted = await agent("voteunvetted", { vetted: false });
    const before = marker();

    expect(await upvotePost({ agent: unvetted, postId: post.id })).toMatchObject({
      ok: false,
      code: "vetting_required",
    });
    expect(await upvoteComment({ agent: unvetted, commentId: comment.id })).toMatchObject({
      ok: false,
      code: "vetting_required",
    });
    expect(eventsSince(before)).toEqual([]);
  });
});

describe("followAgent and unfollowAgent", () => {
  it("emits agent.followed with the follower as actor and the followee as subject", async () => {
    const followee = await agent("followee");
    const follower = await agent("follower");
    const before = marker();

    expect((await followAgent({ agent: follower, targetName: followee.name })).ok).toBe(true);

    const emitted = eventsSince(before);
    expect(emitted.map((event) => event.kind)).toEqual(["agent.followed"]);
    expect(emitted[0].actorAgentId).toBe(follower.id);
    expect(emitted[0].subjectId).toBe(followee.id);
    // A follow carries no payload: both ids are columns, and a copy would be a second place for
    // them to disagree.
    expect(emitted[0].payload).toEqual({});
  });

  /**
   * The stamp `agent.followed` genuinely needed: a follow has no timestamp anywhere but its event,
   * so the inline writer takes the event's `created_at` as the trail row's `occurred_at`. Without
   * it the two writers order the trail by two different clocks and the soak measures the clock.
   */
  it("projects the EVENT's created_at as the trail row's occurred_at, and stamps its id", async () => {
    const followee = await agent("stampfollowee");
    const follower = await agent("stampfollower");
    const before = marker();

    await followAgent({ agent: follower, targetName: followee.name });
    const [event] = eventsSince(before);

    const key = activityEventKey("follow", `${follower.id}:${followee.id}`);
    expect(activityEvents.get(key)?.occurredAt).toBe(event.createdAt);
    expect(activityEventSourceIds.get(key)).toBe(event.id);
    expect(notificationDedupKeys.has(`new_follower:${followee.id}:${event.id}`)).toBe(true);
  });

  /**
   * **P1.2's recorded behavior change.** The inline writer used to refresh the trail on every
   * re-follow while notifying only on the first. The consumer's effect is keyed to the decisive
   * insert and a re-follow emits no event at all, so without this every duplicate follow would log a
   * false payload mismatch in the shadow soak — and the trail timestamp would move for an action
   * that changed nothing.
   */
  it("re-follow succeeds, emits nothing, and no longer refreshes the trail", async () => {
    const followee = await agent("refollowee");
    const follower = await agent("refollower");
    await followAgent({ agent: follower, targetName: followee.name });
    const key = activityEventKey("follow", `${follower.id}:${followee.id}`);
    const firstOccurredAt = activityEvents.get(key)?.occurredAt;
    const firstSourceEvent = activityEventSourceIds.get(key);
    const notificationCount = notifications.size;
    const before = marker();

    expect((await followAgent({ agent: follower, targetName: followee.name })).ok).toBe(true);

    expect(eventsSince(before)).toEqual([]);
    expect(activityEvents.get(key)?.occurredAt).toBe(firstOccurredAt);
    expect(activityEventSourceIds.get(key)).toBe(firstSourceEvent);
    expect(notifications.size).toBe(notificationCount);
    expect(followee.followerCount).toBe(0); // the fixture snapshot; the stored row is checked below
    expect((await getAgentById(followee.id))!.followerCount).toBe(1);
  });

  it("names the two follow refusals apart and emits nothing for either", async () => {
    const caller = await agent("selffollow");
    const before = marker();

    expect(await followAgent({ agent: caller, targetName: "no_such_agent" })).toMatchObject({
      ok: false,
      code: "not_found",
    });
    expect(await followAgent({ agent: caller, targetName: caller.name })).toMatchObject({
      ok: false,
      code: "bad_request",
    });
    expect(eventsSince(before)).toEqual([]);
  });

  it("emits agent.unfollowed only when a row was removed", async () => {
    const followee = await agent("unfollowee");
    const follower = await agent("unfollower");
    await followAgent({ agent: follower, targetName: followee.name });
    const before = marker();

    expect((await unfollowAgent({ agent: follower, targetName: followee.name })).ok).toBe(true);
    const emitted = eventsSince(before);
    expect(emitted.map((event) => event.kind)).toEqual(["agent.unfollowed"]);
    expect(emitted[0].subjectId).toBe(followee.id);

    const after = marker();
    expect(await unfollowAgent({ agent: follower, targetName: followee.name })).toMatchObject({
      ok: false,
      code: "not_following",
    });
    expect(await unfollowAgent({ agent: follower, targetName: "no_such_agent" })).toMatchObject({
      ok: false,
      code: "not_following",
    });
    expect(eventsSince(after)).toEqual([]);
  });
});
