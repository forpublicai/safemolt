/**
 * M11-2 u3b (P1.2), codex round 3 — **the comment refusal is decided by the statement, not rebuilt
 * from later reads.**
 *
 * `createCommentWithOutcome` returns `post_exists`, `parent_valid` and `admitted` from a scalar
 * projection with no `FROM`, so it answers exactly one row on every path — refusals included — and
 * those three flags were evaluated against one snapshot under the statement's own post lock.
 *
 * The action used to reconstruct them afterwards: re-read the post, re-read the parent, then blame
 * the rate limit. That inverted P1.2's pinned precedence the moment anything changed in between —
 * **a post deleted after a cap refusal made the re-read answer "not found" for a request that was
 * really rate limited**, and the caller was told to give up on a post that had merely filled their
 * daily quota.
 *
 * The window between the store call and the classification is not reachable from outside, so it is
 * entered from inside: the store is stubbed to delegate to the REAL memory store and then delete the
 * post before returning. Nothing about the refusal itself is faked — the outcome handed back is the
 * one the real statement produced.
 *
 * @jest-environment node
 */
jest.mock("@/lib/store", () => {
  const actual = jest.requireActual("@/lib/store");
  return { ...actual, createCommentWithOutcome: jest.fn(actual.createCommentWithOutcome) };
});

import { createComment } from "@/lib/actions/comments";
import * as store from "@/lib/store";
import { commentCountToday, lastCommentAt, posts } from "@/lib/store/_memory-state";
import { createAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import { MAX_COMMENTS_PER_DAY } from "@/lib/store/rate-limit-windows";
import { clearRateWindows, seedComment, seedPost } from "@/__tests__/helpers/store-fixtures";
import type { CreateCommentOutcome, StoredAgent } from "@/lib/store-types";

const createCommentWithOutcome = store.createCommentWithOutcome as jest.Mock;
const realCreateComment = jest.requireActual("@/lib/store")
  .createCommentWithOutcome as typeof store.createCommentWithOutcome;

let seq = 0;
const nextName = (label: string) => `u3bc_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

async function agent(label: string): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "u3b classification fixture");
  await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

/** Put the agent at its daily cap with the cooldown already elapsed, so the CAP is what refuses. */
function fillDailyBudget(agentId: string): void {
  lastCommentAt.set(agentId, Date.now() - 60_000);
  commentCountToday.set(agentId, { date: new Date().toISOString().slice(0, 10), count: MAX_COMMENTS_PER_DAY });
}

beforeEach(() => {
  clearRateWindows();
  // `mockReset`, not `mockClear`: a `mockImplementationOnce` that a test queued but never consumed
  // (the action can refuse before reaching the store) would otherwise be picked up by the NEXT
  // test's call and quietly answer for the wrong scenario.
  createCommentWithOutcome.mockReset();
  createCommentWithOutcome.mockImplementation(realCreateComment);
});

describe("createComment — the refusal the statement decided is the refusal published", () => {
  it("stays rate_limited when the post is deleted between the refusal and the classification", async () => {
    const author = await agent("author");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "quota subject");
    const commenter = await agent("commenter");
    // One slot left, so the action's friendly pre-check ALLOWS and the statement is actually
    // reached — the cap then fills inside the window, which is the race this gate is about.
    lastCommentAt.set(commenter.id, Date.now() - 60_000);
    commentCountToday.set(commenter.id, {
      date: new Date().toISOString().slice(0, 10),
      count: MAX_COMMENTS_PER_DAY - 1,
    });

    let observed: CreateCommentOutcome | null = null;
    createCommentWithOutcome.mockImplementationOnce(async (...args: Parameters<typeof realCreateComment>) => {
      // The agent's last slot goes to somebody else's request first: the statement now refuses on
      // the cap, exactly as it would under real contention.
      fillDailyBudget(commenter.id);
      const outcome = await realCreateComment(...args);
      observed = outcome;
      // **The window**: the statement has already refused on the cap; the post now goes away before
      // the action gets to classify. A re-read would answer "gone"; the flags say otherwise.
      posts.get(post.id)!.deletedAt = new Date().toISOString();
      return outcome;
    });

    const result = await createComment({ agent: commenter, postId: post.id, content: "over the cap" });

    // What the statement actually decided: the post was live, the parent was fine, the cap refused.
    expect(observed).toMatchObject({ comment: null, postExists: true, parentValid: true, admitted: false });
    // And that is what the caller is told — with the window, not "post not found".
    expect(result).toMatchObject({ ok: false, code: "rate_limited" });
    expect(result.ok === false && result.dailyRemaining).toBe(0);
  });

  it("stays invalid_parent when the post is deleted between the refusal and the classification", async () => {
    const author = await agent("parentauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "reply subject");
    const elsewhere = await seedPost(author.id, group.id, "another");
    const foreign = await seedComment(elsewhere.id, author.id, "on another post");
    const replier = await agent("replier");
    clearRateWindows();

    // The action's own pre-check would catch this parent, so it is neutralised for this gate: the
    // point is what happens when the STATEMENT is the one that refuses, which is the raced case
    // (M11-1b D3: the parent can move or die after the pre-check).
    createCommentWithOutcome.mockImplementationOnce(async () => {
      posts.get(post.id)!.deletedAt = new Date().toISOString();
      return { comment: null, postExists: true, parentValid: false, admitted: false };
    });

    const result = await createComment({
      agent: replier,
      postId: post.id,
      content: "a reply",
      parentId: foreign.id,
    });

    expect(result).toMatchObject({ ok: false, code: "invalid_parent" });
  });

  it("still answers not_found when the STATEMENT is what found the post gone", async () => {
    const author = await agent("goneauthor");
    const group = await createGroup(nextName("grp"), "U3b", "", author.id);
    const post = await seedPost(author.id, group.id, "doomed subject");
    const commenter = await agent("gonecommenter");
    clearRateWindows();

    // The post dies after the action's own live read and before the statement runs — the ordinary
    // C25 race. The flags, not a later read, are what report it.
    createCommentWithOutcome.mockImplementationOnce(async (...args: Parameters<typeof realCreateComment>) => {
      posts.get(post.id)!.deletedAt = new Date().toISOString();
      return realCreateComment(...args);
    });

    const result = await createComment({ agent: commenter, postId: post.id, content: "too late" });

    expect(result).toMatchObject({ ok: false, code: "not_found" });
    // And nothing was charged for it, which is the other half of the same statement's contract.
    expect(lastCommentAt.has(commenter.id)).toBe(false);
  });
});
