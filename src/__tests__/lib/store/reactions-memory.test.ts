/**
 * M11b lane R (P6.2) — reactions in **memory mode**, the mode Jest and local development run.
 *
 * Drives the real entry points: `actions/reactions` for everything that must observe an event, a
 * notification or the daily cap (the same path the routes and tools use), and the store functions
 * directly for the two purely-storage properties (subject-type scoping, the `deletePost` splice).
 *
 * @jest-environment node
 */
import { addReaction as actionAddReaction, removeReaction as actionRemoveReaction } from "@/lib/actions/reactions";
import {
  addReaction as storeAddReaction,
  removeReaction as storeRemoveReaction,
  deletePost,
  getReactionCounts,
  listNotifications,
} from "@/lib/store";
import { createAgent, deleteAgent, getAgentById } from "@/lib/store/agents/memory";
import { comments, contentReactions, eventLog, posts, reactionCountToday, wakeupQueue } from "@/lib/store/_memory-state";
import { seedComment, seedPost } from "@/__tests__/helpers/store-fixtures";
import type { PreparedEvent } from "@/lib/events/kinds";
import type { StoredAgent } from "@/lib/store-types";

const RUN = `${Date.now().toString(36)}`;
const GROUP = `react_grp_${RUN}`;
let seq = 0;

async function freshAgent(): Promise<StoredAgent> {
  const created = await createAgent(`ReactMem_${RUN}_${(seq += 1)}`, "reactions memory fixture");
  return (await getAgentById(created.id))!;
}

/** Set REACTION_DAILY_LIMIT for the duration of `run`, restoring whatever was there before. */
async function withDailyLimit<T>(limit: number, run: () => Promise<T>): Promise<T> {
  const prev = process.env.REACTION_DAILY_LIMIT;
  process.env.REACTION_DAILY_LIMIT = String(limit);
  try {
    return await run();
  } finally {
    if (prev === undefined) delete process.env.REACTION_DAILY_LIMIT;
    else process.env.REACTION_DAILY_LIMIT = prev;
  }
}

describe("addReaction / removeReaction (memory) — idempotence", () => {
  it("a second addReaction for the same (agent, subject, emoji) reports already_reacted and leaves counts unchanged", async () => {
    const author = await freshAgent();
    const reactor = await freshAgent();
    const post = await seedPost(author.id, GROUP, "idempotent react");

    const first = await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "👍" });
    expect(first.ok).toBe(true);
    const countsAfterFirst = (await getReactionCounts("post", [post.id]))[post.id];
    expect(countsAfterFirst).toEqual({ "👍": 1 });

    const second = await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "👍" });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("already_reacted");
    expect((await getReactionCounts("post", [post.id]))[post.id]).toEqual(countsAfterFirst);
  });

  it("removeReaction succeeds once; a second removeReaction on the same triple reports not_found", async () => {
    const author = await freshAgent();
    const reactor = await freshAgent();
    const post = await seedPost(author.id, GROUP, "idempotent unreact");
    expect((await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "🎉" })).ok).toBe(true);

    const removed = await actionRemoveReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "🎉" });
    expect(removed.ok).toBe(true);

    const removedAgain = await actionRemoveReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "🎉" });
    expect(removedAgain.ok).toBe(false);
    if (!removedAgain.ok) expect(removedAgain.code).toBe("not_found");
  });
});

describe("getReactionCounts — scoped by subjectType, not merely by subjectId", () => {
  it("a post and a comment sharing the SAME id string do not share counts", async () => {
    const author = await freshAgent();
    const reactor = await freshAgent();
    const sharedId = `collide_${RUN}`;
    // Forced collision: real ids never collide (post_N vs comment_N), so the only way to prove
    // subjectType is actually part of the lookup key is to plant both under one id by hand.
    posts.set(sharedId, {
      id: sharedId,
      title: "collision post",
      authorId: author.id,
      groupId: GROUP,
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
      createdAt: new Date().toISOString(),
    });
    comments.set(sharedId, {
      id: sharedId,
      postId: sharedId,
      authorId: author.id,
      content: "collision comment",
      upvotes: 0,
      createdAt: new Date().toISOString(),
    });

    const postReact = await storeAddReaction({
      agentId: reactor.id,
      subjectType: "post",
      subjectId: sharedId,
      emoji: "👍",
      dailyLimit: 200,
    });
    expect(postReact.outcome).toBe("added");
    const commentReact = await storeAddReaction({
      agentId: reactor.id,
      subjectType: "comment",
      subjectId: sharedId,
      emoji: "🚀",
      dailyLimit: 200,
    });
    expect(commentReact.outcome).toBe("added");

    // Mutation check: if `subjectType` were dropped from the storage key (`getReactionKey`), both
    // calls above would write ONE row keyed only by subjectId, and `postCounts` below would show
    // BOTH emoji instead of just the post's own — the comment's reaction would leak in.
    const postCounts = (await getReactionCounts("post", [sharedId]))[sharedId];
    const commentCounts = (await getReactionCounts("comment", [sharedId]))[sharedId];
    expect(postCounts).toEqual({ "👍": 1 });
    expect(commentCounts).toEqual({ "🚀": 1 });
  });
});

describe("deletePost cleans up reactions on the post and on its comments", () => {
  it("removes both rows when the author deletes the post", async () => {
    const author = await freshAgent();
    const reactor = await freshAgent();
    const post = await seedPost(author.id, GROUP, "doomed by delete");
    const comment = await seedComment(post.id, author.id, "a comment on the doomed post");

    expect((await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "👍" })).ok).toBe(true);
    expect(
      (await actionAddReaction({ agent: reactor, subjectType: "comment", subjectId: comment.id, emoji: "🎉" })).ok
    ).toBe(true);

    const deletion = await deletePost(post.id, author.id);
    expect(deletion.deleted).toBe(true);

    expect((await getReactionCounts("post", [post.id]))[post.id]).toEqual({});
    expect((await getReactionCounts("comment", [comment.id]))[comment.id]).toEqual({});
  });
});

describe("the daily reaction cap", () => {
  it("binds after dailyLimit adds, and the refusal carries a same-day retryAfterSeconds", async () => {
    await withDailyLimit(2, async () => {
      const reactor = await freshAgent();
      const author = await freshAgent();
      const p1 = await seedPost(author.id, GROUP, "cap 1");
      const p2 = await seedPost(author.id, GROUP, "cap 2");
      const p3 = await seedPost(author.id, GROUP, "cap 3");

      expect((await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: p1.id, emoji: "👍" })).ok).toBe(true);
      expect((await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: p2.id, emoji: "👍" })).ok).toBe(true);

      const third = await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: p3.id, emoji: "👍" });
      // Mutation check: if the cap gate (`usedToday >= input.dailyLimit` in `store/reactions/memory.ts`)
      // were removed, this third add — past dailyLimit=2 — would report ok:true and a third counted
      // reaction would exist. Instead it must refuse rate_limited and write nothing.
      expect(third.ok).toBe(false);
      if (!third.ok) {
        expect(third.code).toBe("rate_limited");
        expect(third.retryAfterSeconds).toBeGreaterThan(0);
        expect(third.retryAfterSeconds).toBeLessThanOrEqual(86400);
      }
      expect((await getReactionCounts("post", [p3.id]))[p3.id]).toEqual({});
    });
  });

  it("removeReaction never checks or refunds the cap: removing everything still leaves the counter charged", async () => {
    await withDailyLimit(2, async () => {
      const reactor = await freshAgent();
      const author = await freshAgent();
      const p1 = await seedPost(author.id, GROUP, "uncapped 1");
      const p2 = await seedPost(author.id, GROUP, "uncapped 2");
      const p3 = await seedPost(author.id, GROUP, "uncapped 3");

      expect((await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: p1.id, emoji: "👍" })).ok).toBe(true);
      expect((await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: p2.id, emoji: "👍" })).ok).toBe(true);

      // Removal succeeds unconditionally, even though the agent is at the cap.
      expect((await actionRemoveReaction({ agent: reactor, subjectType: "post", subjectId: p1.id, emoji: "👍" })).ok).toBe(true);
      expect((await actionRemoveReaction({ agent: reactor, subjectType: "post", subjectId: p2.id, emoji: "👍" })).ok).toBe(true);

      // Mutation check: if removeReaction refunded the counter (decremented `reactionCountToday`),
      // this fresh react past the original cap boundary would succeed. The store never touches the
      // counter on delete, so it must still refuse — this is what "removal is uncapped" actually
      // means here: the DELETE itself is never checked against the cap, not that it un-charges it.
      const afterRemoval = await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: p3.id, emoji: "👍" });
      expect(afterRemoval.ok).toBe(false);
      if (!afterRemoval.ok) expect(afterRemoval.code).toBe("rate_limited");
    });
  });
});

describe("a duplicate addReaction", () => {
  it("charges no quota and emits no second event", async () => {
    const reactor = await freshAgent();
    const author = await freshAgent();
    const post = await seedPost(author.id, GROUP, "duplicate charge");

    const before = eventLog.nextId;
    const first = await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "👍" });
    expect(first.ok).toBe(true);
    const afterFirst = eventLog.nextId;
    expect(afterFirst).toBe(before + 1);
    const quotaAfterFirst = reactionCountToday.get(reactor.id)?.count;
    expect(quotaAfterFirst).toBe(1);

    const second = await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "👍" });
    // Mutation check: `addReaction` in `store/reactions/memory.ts` returns "already_reacted" BEFORE
    // touching the quota map or preparing an event. If that early return were removed and the
    // duplicate fell through to the write path, `eventLog.nextId` would advance a second time and
    // `reactionCountToday`'s count would read 2 instead of 1 — either assertion below would catch it.
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.code).toBe("already_reacted");
    expect(eventLog.nextId).toBe(afterFirst);
    expect(reactionCountToday.get(reactor.id)?.count).toBe(quotaAfterFirst);
  });
});

describe("the reaction_added notification", () => {
  it("is projected for the content author, but not for a self-reaction", async () => {
    const author = await freshAgent();
    const reactor = await freshAgent();
    const post = await seedPost(author.id, GROUP, "notify the author");

    expect((await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "👍" })).ok).toBe(true);

    const authorNotifications = (await listNotifications(author.id)).filter((n) => n.type === "reaction_added");
    expect(authorNotifications).toHaveLength(1);
    expect(authorNotifications[0].metadata).toMatchObject({
      subject_type: "post",
      subject_id: post.id,
      emoji: "👍",
    });

    const ownPost = await seedPost(author.id, GROUP, "self reaction");
    expect((await actionAddReaction({ agent: author, subjectType: "post", subjectId: ownPost.id, emoji: "👍" })).ok).toBe(true);
    const selfNotifications = (await listNotifications(author.id)).filter(
      (n) => n.type === "reaction_added" && n.metadata.subject_id === ownPost.id
    );
    // Mutation check: if the actor===author skip in `planReactionNotification` were removed, this
    // self-reaction would produce a row here; the list must stay empty.
    expect(selfNotifications).toHaveLength(0);
  });
});

describe("no wakeup", () => {
  it("queues no wakeup row for a reaction", async () => {
    const author = await freshAgent();
    const reactor = await freshAgent();
    const post = await seedPost(author.id, GROUP, "no wakeup");
    const before = wakeupQueue.nextId;

    expect((await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "👍" })).ok).toBe(true);

    // Mutation check: a wakeup route case for `reaction.added` would insert a row and advance this
    // counter; the coverage manifest marks it "none" everywhere, so nothing should move it.
    expect(wakeupQueue.nextId).toBe(before);
  });
});

describe("F4: a concurrent duplicate add in memory mode", () => {
  it("two Promise.all'd identical adds leave one added, one already_reacted — never a second row or event", async () => {
    const author = await freshAgent();
    const reactor = await freshAgent();
    const post = await seedPost(author.id, GROUP, "concurrent duplicate");
    const before = eventLog.nextId;

    const [first, second] = await Promise.all([
      actionAddReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "👍" }),
      actionAddReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "👍" }),
    ]);
    const outcomes = [first, second].map((r) => (r.ok ? "added" : r.code));

    expect(outcomes.sort()).toEqual(["added", "already_reacted"]);
    expect((await getReactionCounts("post", [post.id]))[post.id]).toEqual({ "👍": 1 });
    expect(eventLog.nextId).toBe(before + 1);
  });
});

describe("F3: the acting agent is re-checked before the memory mutation", () => {
  it("a reactor withdrawn just before the store call is refused not_found, charging nothing and emitting nothing", async () => {
    const author = await freshAgent();
    const reactor = await freshAgent();
    const post = await seedPost(author.id, GROUP, "withdrawn reactor");

    // Simulates the action's own subject/group reads racing a withdrawal: by the time the store
    // call runs, the agent id it was given no longer resolves.
    expect((await deleteAgent(reactor.id)).ok).toBe(true);

    const before = eventLog.nextId;
    const result = await storeAddReaction({
      agentId: reactor.id,
      subjectType: "post",
      subjectId: post.id,
      emoji: "👍",
      dailyLimit: 200,
    });

    // Mutation check: removing the `agents.has(input.agentId)` guard in `store/reactions/memory.ts`
    // lets this fall through to the insert — outcome flips to "added", the quota map gains an
    // entry, and `eventLog.nextId` advances. With the guard, none of that happens.
    expect(result.outcome).toBe("not_found");
    expect((await getReactionCounts("post", [post.id]))[post.id]).toEqual({});
    expect(reactionCountToday.get(reactor.id)).toBeUndefined();
    expect(eventLog.nextId).toBe(before);
  });
});

describe("F4: memory validates events before any refusal (parity with db)", () => {
  const badEvent = {
    kind: "not.a.real.kind",
    actorAgentId: "whoever",
    subjectType: "post",
    subjectId: "no-such-post",
    payload: {},
  } as unknown as PreparedEvent;

  it("addReaction throws on an invalid event even against a missing subject, rather than returning not_found", async () => {
    const reactor = await freshAgent();
    // Mutation check: moving the `prepareEventBatch` call back below the subject check makes this
    // resolve to `{ outcome: "not_found" }` instead of throwing — the db side always validates
    // first, since `emitEventCtes` runs before the transaction is even submitted.
    await expect(
      storeAddReaction(
        { agentId: reactor.id, subjectType: "post", subjectId: "no-such-post", emoji: "👍", dailyLimit: 200 },
        [badEvent]
      )
    ).rejects.toThrow();
  });

  it("removeReaction throws on an invalid event even against a missing subject, rather than returning not_found", async () => {
    const reactor = await freshAgent();
    await expect(
      storeRemoveReaction(
        { agentId: reactor.id, subjectType: "post", subjectId: "no-such-post", emoji: "👍" },
        [badEvent]
      )
    ).rejects.toThrow();
  });
});

describe("F7: removal is gated on the live subject", () => {
  it("a reaction row surviving its post's deletion cannot be removed: writes nothing, emits nothing", async () => {
    const author = await freshAgent();
    const reactor = await freshAgent();
    const post = await seedPost(author.id, GROUP, "removed after delete");
    expect((await actionAddReaction({ agent: reactor, subjectType: "post", subjectId: post.id, emoji: "👍" })).ok).toBe(true);

    const deletion = await deletePost(post.id, author.id);
    expect(deletion.deleted).toBe(true);
    // `deletePost`'s own cleanup already removed the row; plant a stale one back to stand in for a
    // row no live-subject check has reached yet — the case F7 closes.
    contentReactions.set(`${reactor.id}:post:${post.id}:👍`, {
      agentId: reactor.id,
      subjectType: "post",
      subjectId: post.id,
      emoji: "👍",
      createdAt: new Date().toISOString(),
    });

    const before = eventLog.nextId;
    const result = await storeRemoveReaction({
      agentId: reactor.id,
      subjectType: "post",
      subjectId: post.id,
      emoji: "👍",
    });

    // Mutation check: dropping the `isSubjectLive` half of `removed` in
    // `store/reactions/memory.ts` reports "removed" here, because the row itself is still present
    // in `contentReactions` — the whole point of F7 is that the subject's liveness gates it too.
    expect(result.outcome).toBe("not_found");
    expect(eventLog.nextId).toBe(before);
  });
});
