/**
 * M11-1 C16 — the two "counter drift" cases that were actually exploitable, in memory mode.
 *
 * Both were advisory before this chunk: the caller read a limit, the store wrote without one, and
 * anything concurrent slipped between. These tests call the store **directly** (not through the
 * fixture seeders, which clear the windows on purpose) because the windows are the subject.
 *
 * @jest-environment node
 */
import { agents, commentCountToday, comments, lastCommentAt, lastPostAt, posts, resetGroupState } from "@/lib/store/_memory-state";
import { COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY, POST_COOLDOWN_MS } from "@/lib/store/rate-limit-windows";
import { createAgent, followAgent, getAgentById, unfollowAgent } from "@/lib/store/agents/memory";
import { checkCommentRateLimit, checkPostRateLimit, createPost } from "@/lib/store/posts/memory";
import { createComment } from "@/lib/store/comments/memory";

const GROUP = "c16_group";

beforeEach(() => {
  posts.clear();
  comments.clear();
  resetGroupState();
  agents.clear();
  lastPostAt.clear();
  lastCommentAt.clear();
  commentCountToday.clear();
});

describe("unfollow no longer decrements a counter it did not touch", () => {
  it("refuses an unfollow of an agent that was never followed, and moves no counter", async () => {
    const target = await createAgent("c16_target", "Target");
    const stranger = await createAgent("c16_stranger", "Stranger");
    await followAgent(stranger.id, target.name);

    const before = (await getAgentById(target.id))!.followerCount;
    expect(before).toBe(1);

    const attacker = await createAgent("c16_attacker", "Attacker");
    for (let i = 0; i < 5; i++) {
      // The exploit, five times: before C16 the db store issued an unconditional decrement here
      // and reported success, so this loop walked a public follower count down to zero.
      expect(await unfollowAgent(attacker.id, target.name)).toBe(false);
    }

    expect((await getAgentById(target.id))!.followerCount).toBe(before);
  });

  it("still decrements exactly once for a real unfollow", async () => {
    const target = await createAgent("c16_target2", "Target");
    const follower = await createAgent("c16_follower2", "Follower");
    await followAgent(follower.id, target.name);
    expect((await getAgentById(target.id))!.followerCount).toBe(1);

    expect(await unfollowAgent(follower.id, target.name)).toBe(true);
    expect((await getAgentById(target.id))!.followerCount).toBe(0);

    // A second unfollow of the same pair is now a refusal, not a second decrement.
    expect(await unfollowAgent(follower.id, target.name)).toBe(false);
    expect((await getAgentById(target.id))!.followerCount).toBe(0);
  });
});

describe("the post cooldown is enforced by the write, not advised before it", () => {
  it("admits exactly one of several concurrent posts from one agent", async () => {
    const author = await createAgent("c16_poster", "Poster");

    const results = await Promise.all(
      [1, 2, 3, 4].map((n) => createPost(author.id, GROUP, `race ${n}`, "body"))
    );

    expect(results.filter((p) => p !== null)).toHaveLength(1);
    expect(posts.size).toBe(1);
  });

  it("admits the next post once the cooldown has expired, and refuses before it", async () => {
    const author = await createAgent("c16_poster2", "Poster");

    expect(await createPost(author.id, GROUP, "first", "body")).not.toBeNull();
    expect(await createPost(author.id, GROUP, "second", "body")).toBeNull();

    lastPostAt.set(author.id, Date.now() - POST_COOLDOWN_MS - 1);
    expect(await createPost(author.id, GROUP, "after the window", "body")).not.toBeNull();
    expect(posts.size).toBe(2);
  });

  it("charges no quota for a refused post", async () => {
    const author = await createAgent("c16_poster3", "Poster");
    await createPost(author.id, GROUP, "first", "body");
    const stampAfterFirst = lastPostAt.get(author.id);

    expect(await createPost(author.id, GROUP, "refused", "body")).toBeNull();

    // A refusal that moved the stamp would extend the caller's own cooldown every time it was
    // refused — a limiter that punishes retrying rather than bounding the rate.
    expect(lastPostAt.get(author.id)).toBe(stampAfterFirst);
  });
});

describe("the comment cooldown and the daily cap are enforced by the write", () => {
  async function seedLivePost(authorId: string): Promise<string> {
    const post = await createPost(authorId, GROUP, "host post", "body");
    lastPostAt.clear();
    return post!.id;
  }

  it("admits exactly one of several concurrent comments — the cooldown, not the cap, binds", async () => {
    // Shape (b) from the plan: from an empty bucket, the 20s cooldown is what refuses the rest.
    // A gate asserting "exactly MAX_COMMENTS_PER_DAY inserts" here could only pass with the
    // cooldown switched off, which is why the two limits get separate gates.
    const author = await createAgent("c16_commenter", "Commenter");
    const postId = await seedLivePost(author.id);

    const results = await Promise.all(
      [1, 2, 3, 4, 5].map((n) => createComment(postId, author.id, `race ${n}`))
    );

    expect(results.filter((c) => c !== null)).toHaveLength(1);
    expect(commentCountToday.get(author.id)).toEqual({
      date: new Date().toISOString().slice(0, 10),
      count: 1,
    });
  });

  it("lands exactly on the daily cap when two requests race for the last slot", async () => {
    // Shape (a): preseed at the cap minus one with an expired cooldown, so the *cap* is the only
    // thing that can refuse. Before C16 the count was an unlocked read-modify-write, so both
    // requests read `cap - 1`, both wrote `cap`, and the agent got one comment past its limit.
    const author = await createAgent("c16_commenter2", "Commenter");
    const postId = await seedLivePost(author.id);
    const today = new Date().toISOString().slice(0, 10);

    commentCountToday.set(author.id, { date: today, count: MAX_COMMENTS_PER_DAY - 1 });
    lastCommentAt.set(author.id, Date.now() - COMMENT_COOLDOWN_MS - 1);

    const results = await Promise.all([
      createComment(postId, author.id, "last slot A"),
      createComment(postId, author.id, "last slot B"),
    ]);

    expect(results.filter((c) => c !== null)).toHaveLength(1);
    expect(commentCountToday.get(author.id)?.count).toBe(MAX_COMMENTS_PER_DAY);
  });

  it("refuses at the cap and charges nothing for the refusal", async () => {
    const author = await createAgent("c16_commenter3", "Commenter");
    const postId = await seedLivePost(author.id);
    const today = new Date().toISOString().slice(0, 10);

    commentCountToday.set(author.id, { date: today, count: MAX_COMMENTS_PER_DAY });
    lastCommentAt.set(author.id, Date.now() - COMMENT_COOLDOWN_MS - 1);

    expect(await createComment(postId, author.id, "over the cap")).toBeNull();
    expect(commentCountToday.get(author.id)?.count).toBe(MAX_COMMENTS_PER_DAY);
    expect((await checkCommentRateLimit(author.id)).allowed).toBe(false);
  });

  it("starts a fresh allowance when the day rolls over", async () => {
    const author = await createAgent("c16_commenter4", "Commenter");
    const postId = await seedLivePost(author.id);

    commentCountToday.set(author.id, { date: "2020-01-01", count: MAX_COMMENTS_PER_DAY });
    lastCommentAt.set(author.id, Date.now() - COMMENT_COOLDOWN_MS - 1);

    expect(await createComment(postId, author.id, "new day")).not.toBeNull();
    expect(commentCountToday.get(author.id)).toEqual({
      date: new Date().toISOString().slice(0, 10),
      count: 1,
    });
  });

  it("charges no quota for a comment on a post that is gone", async () => {
    // The claim is chained after the liveness check on purpose: a comment nobody could have made
    // must not spend the caller's allowance.
    const author = await createAgent("c16_commenter5", "Commenter");
    await seedLivePost(author.id);

    expect(await createComment("post_that_never_existed", author.id, "into the void")).toBeNull();
    expect(lastCommentAt.get(author.id)).toBeUndefined();
    expect(commentCountToday.get(author.id)).toBeUndefined();
    expect((await checkPostRateLimit(author.id)).allowed).toBe(true);
  });
});
