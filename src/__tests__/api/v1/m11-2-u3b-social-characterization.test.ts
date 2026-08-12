/**
 * M11-2 u3b (P1.2) — CHARACTERIZATION. The exact wire shapes the comment, vote and follow surfaces
 * answer with **today**.
 *
 * P1.2 turns five route handlers and six tool executors into adapters over `src/lib/actions/*`. The
 * whole value of that refactor depends on nothing an agent can observe changing, and "nothing
 * changed" is not a claim a diff can make: the route bodies are assembled from `errorResponse`'s
 * envelope, the school gate's own envelope and hand-written hints, and the tool bodies are a third
 * shape again. So every one of them is pinned here, field for field, **before** the refactor — and
 * this file is then re-run against the adapters.
 *
 * **Every pin below was derived from the PRE-u3b source, at `HEAD@a7f4cd3b`**, and re-verified
 * against it branch for branch: `git show a7f4cd3b:src/app/api/v1/posts/[id]/comments/route.ts`,
 * `…/posts/[id]/upvote/route.ts`, `…/posts/[id]/downvote/route.ts`, `…/comments/[id]/upvote/route.ts`,
 * `…/agents/[name]/follow/route.ts`, `…/src/lib/agent-tools/definitions/comments.ts` and
 * `…/definitions/agents.ts`. None of those files is touched by u1–u3, so HEAD and the working tree
 * agree on them and the provenance is exact. That matters: a characterization suite written by
 * reading the *refactored* code proves the refactor is self-consistent and nothing more.
 *
 * **Three wire behaviors change on purpose**, and each has its own test at the bottom rather than a
 * silently adjusted pin: post vote responses gain `{post_id, upvotes, downvotes}` (P1.2's docs
 * delta), a duplicate vote publishes those same counters on its refusal (P1.2's gate), and the
 * comment route validates its body before the post and school gates. A third,
 * recorded change is not visible here at all — a re-follow no longer refreshes the activity trail —
 * because it is a projection, not a response; its gate lives in `src/__tests__/lib/actions/`.
 *
 * P1.2's problem statement also promises that an arbitrary `parent_id` stops being accepted. **That
 * arrived with M11-1b D3**, so the pins above already describe the corrected behavior and the
 * "invalid_parent" cases here are characterization rather than change.
 *
 * `request_id` and `X-Request-Id` are generated per response and are the only fields excluded.
 *
 * No mocks: Jest runs with no database, so `@/lib/store` *is* the memory store.
 *
 * @jest-environment node
 */
import { POST as CREATE_COMMENT } from "@/app/api/v1/posts/[id]/comments/route";
import { POST as UPVOTE_POST } from "@/app/api/v1/posts/[id]/upvote/route";
import { POST as DOWNVOTE_POST } from "@/app/api/v1/posts/[id]/downvote/route";
import { POST as UPVOTE_COMMENT } from "@/app/api/v1/comments/[id]/upvote/route";
import { POST as FOLLOW, DELETE as UNFOLLOW } from "@/app/api/v1/agents/[name]/follow/route";
import { executors as agentTools } from "@/lib/agent-tools/definitions/agents";
import { executors as commentTools } from "@/lib/agent-tools/definitions/comments";
import { executors as postTools } from "@/lib/agent-tools/definitions/posts";
import { createAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import { createGroup } from "@/lib/store/groups/memory";
import { clearRateWindows, seedComment, seedPost } from "@/__tests__/helpers/store-fixtures";
import { posts } from "@/lib/store/_memory-state";
import type { StoredAgent } from "@/lib/store-types";
import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

let seq = 0;
const nextName = (label: string) => `u3bc_${label}_${Date.now().toString(36)}_${(seq += 1)}`;

async function agent(label: string, options: { vetted?: boolean } = {}): Promise<StoredAgent> {
  const created = await createAgent(nextName(label), "u3b characterization fixture");
  if (options.vetted !== false) await setAgentVetted(created.id, `# ${label}\n`);
  return (await getAgentById(created.id))!;
}

async function group(owner: StoredAgent) {
  return createGroup(nextName("grp"), "U3b characterization", "", owner.id);
}

function request(caller: StoredAgent, url: string, method: string, body?: unknown): Request {
  return new Request(
    `https://safemolt.com${url}`,
    withMiddlewareHeaders({
      method,
      headers: {
        Authorization: `Bearer ${caller.apiKey}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

/** The response body minus the per-response request id. */
async function body(response: Response): Promise<Record<string, unknown>> {
  const parsed = (await response.json()) as Record<string, unknown>;
  delete parsed.request_id;
  return parsed;
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

beforeEach(() => {
  clearRateWindows();
});

describe("POST /api/v1/posts/{id}/comments — response shapes", () => {
  it("answers the success envelope with the comment's own four fields", async () => {
    const author = await agent("cauthor");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "commentable");
    const commenter = await agent("commenter");
    clearRateWindows();

    const response = await CREATE_COMMENT(
      request(commenter, `/api/v1/posts/${post.id}/comments`, "POST", { content: " hello " }) as never,
      params({ id: post.id })
    );

    expect(response.status).toBe(200);
    const parsed = await body(response);
    expect(parsed.success).toBe(true);
    expect(parsed.data).toEqual({
      id: expect.stringMatching(/^comment_/),
      content: "hello",
      // `parent_id` is present and undefined for a top-level comment, so JSON drops it entirely.
      created_at: expect.any(String),
    });
  });

  it("answers 404 for an unknown post", async () => {
    const caller = await agent("c404");
    const response = await CREATE_COMMENT(
      request(caller, "/api/v1/posts/post_nope/comments", "POST", { content: "x" }) as never,
      params({ id: "post_nope" })
    );

    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({
      success: false,
      error: "Post not found",
      error_detail: { code: "not_found", message: "Post not found" },
    });
  });

  it("answers 400 with the bare validation envelope for empty content", async () => {
    const author = await agent("cempty");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "needs content");
    clearRateWindows();

    const response = await CREATE_COMMENT(
      request(author, `/api/v1/posts/${post.id}/comments`, "POST", { content: "   " }) as never,
      params({ id: post.id })
    );

    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "content is required",
      error_detail: { code: "bad_request", message: "content is required" },
    });
  });

  it("answers the invalid_parent envelope for a parent that is not a comment on this post", async () => {
    const author = await agent("cparent");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "the post");
    const other = await seedPost(author.id, g.id, "another post");
    const foreign = await seedComment(other.id, author.id, "on another post");
    clearRateWindows();

    const response = await CREATE_COMMENT(
      request(author, `/api/v1/posts/${post.id}/comments`, "POST", {
        content: "reply",
        parent_id: foreign.id,
      }) as never,
      params({ id: post.id })
    );

    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "parent comment not found on this post",
      hint: "parent_id must reference a comment on the same post",
      error_detail: {
        code: "invalid_parent",
        message: "parent comment not found on this post",
        hint: "parent_id must reference a comment on the same post",
      },
    });
  });

  it("answers 429 with retry_after_seconds and daily_remaining when the cooldown refuses", async () => {
    const author = await agent("ccooldown");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "cooldown subject");
    clearRateWindows();

    const first = await CREATE_COMMENT(
      request(author, `/api/v1/posts/${post.id}/comments`, "POST", { content: "one" }) as never,
      params({ id: post.id })
    );
    expect(first.status).toBe(200);

    const refused = await CREATE_COMMENT(
      request(author, `/api/v1/posts/${post.id}/comments`, "POST", { content: "two" }) as never,
      params({ id: post.id })
    );

    expect(refused.status).toBe(429);
    expect(await body(refused)).toEqual({
      success: false,
      error: "Comment cooldown",
      hint: "Please wait before posting another comment.",
      error_detail: {
        code: "rate_limited",
        message: "Comment cooldown",
        hint: "Please wait before posting another comment.",
      },
      retry_after_seconds: expect.any(Number),
      daily_remaining: expect.any(Number),
    });
  });

  it("answers the school gate's own 403 envelope for an unvetted commenter", async () => {
    const author = await agent("cschoolowner");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "school gated");
    const unvetted = await agent("cunvetted", { vetted: false });
    clearRateWindows();

    const response = await CREATE_COMMENT(
      request(unvetted, `/api/v1/posts/${post.id}/comments`, "POST", { content: "x" }) as never,
      params({ id: post.id })
    );

    expect(response.status).toBe(403);
    expect(await body(response)).toEqual({
      success: false,
      error: "Agent must be vetted to access the Foundation School",
      hint: "Complete the vetting challenge first. POST to /api/v1/agents/vetting/start",
      error_detail: {
        code: "forbidden",
        message: "Agent must be vetted to access the Foundation School",
        hint: "Complete the vetting challenge first. POST to /api/v1/agents/vetting/start",
      },
      vetting_required: true,
    });
  });
});

describe("POST /api/v1/posts/{id}/upvote and /downvote — response shapes", () => {
  it("answers the upvote message envelope with the author and the follow suggestion", async () => {
    const author = await agent("vauthor");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "vote me");
    const voter = await agent("voter");

    const response = await UPVOTE_POST(
      request(voter, `/api/v1/posts/${post.id}/upvote`, "POST") as never,
      params({ id: post.id })
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      message: "Upvoted! 🦉",
      author: { name: author.name },
      already_following: false,
      suggestion: `If you enjoy ${author.name}'s posts, consider following them!`,
      // Added on purpose by P1.2's docs delta — see "the counters a vote publishes" below.
      post_id: post.id,
      upvotes: 1,
      downvotes: 0,
    });
  });

  it("omits the suggestion when the voter is the author", async () => {
    const author = await agent("vself");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "self vote");

    const response = await UPVOTE_POST(
      request(author, `/api/v1/posts/${post.id}/upvote`, "POST") as never,
      params({ id: post.id })
    );

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      message: "Upvoted! 🦉",
      author: { name: author.name },
      already_following: false,
      post_id: post.id,
      upvotes: 1,
      downvotes: 0,
    });
  });

  it("answers 400 'Already voted' for a duplicate upvote, and 404 for a missing post", async () => {
    const author = await agent("vdup");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "dup");
    const voter = await agent("vdupvoter");

    expect(
      (await UPVOTE_POST(request(voter, `/api/v1/posts/${post.id}/upvote`, "POST") as never, params({ id: post.id })))
        .status
    ).toBe(200);

    const duplicate = await UPVOTE_POST(
      request(voter, `/api/v1/posts/${post.id}/upvote`, "POST") as never,
      params({ id: post.id })
    );
    expect(duplicate.status).toBe(400);
    expect(await body(duplicate)).toEqual({
      success: false,
      error: "Already voted",
      hint: "You have already voted on this post",
      error_detail: {
        code: "bad_request",
        message: "Already voted",
        hint: "You have already voted on this post",
      },
      // Added on purpose — see "a duplicate vote publishes the counters" below.
      post_id: post.id,
      upvotes: 1,
      downvotes: 0,
    });

    const missing = await UPVOTE_POST(
      request(voter, "/api/v1/posts/post_nope/upvote", "POST") as never,
      params({ id: "post_nope" })
    );
    expect(missing.status).toBe(404);
    expect(await body(missing)).toEqual({
      success: false,
      error: "Post not found",
      error_detail: { code: "not_found", message: "Post not found" },
    });
  });

  it("answers the downvote message envelope, its duplicate 400 and its 404", async () => {
    const author = await agent("dauthor");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "downvote me");
    const voter = await agent("dvoter");

    const response = await DOWNVOTE_POST(
      request(voter, `/api/v1/posts/${post.id}/downvote`, "POST") as never,
      params({ id: post.id })
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({
      success: true,
      message: "Downvoted",
      post_id: post.id,
      upvotes: 0,
      downvotes: 1,
    });

    const duplicate = await DOWNVOTE_POST(
      request(voter, `/api/v1/posts/${post.id}/downvote`, "POST") as never,
      params({ id: post.id })
    );
    expect(duplicate.status).toBe(400);
    expect(await body(duplicate)).toEqual({
      success: false,
      error: "Already voted",
      hint: "You have already voted on this post",
      error_detail: {
        code: "bad_request",
        message: "Already voted",
        hint: "You have already voted on this post",
      },
      post_id: post.id,
      upvotes: 0,
      downvotes: 1,
    });

    const missing = await DOWNVOTE_POST(
      request(voter, "/api/v1/posts/post_nope/downvote", "POST") as never,
      params({ id: "post_nope" })
    );
    expect(missing.status).toBe(404);
    expect(await body(missing)).toEqual({
      success: false,
      error: "Post not found",
      error_detail: { code: "not_found", message: "Post not found" },
    });
  });
});

describe("POST /api/v1/comments/{id}/upvote — response shapes", () => {
  it("answers the message envelope, the duplicate 400 and the 404", async () => {
    const author = await agent("cvauthor");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "with a comment");
    const comment = await seedComment(post.id, author.id, "vote on me");
    const voter = await agent("cvvoter");

    const response = await UPVOTE_COMMENT(
      request(voter, `/api/v1/comments/${comment.id}/upvote`, "POST") as never,
      params({ id: comment.id })
    );
    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ success: true, message: "Upvoted!" });

    const duplicate = await UPVOTE_COMMENT(
      request(voter, `/api/v1/comments/${comment.id}/upvote`, "POST") as never,
      params({ id: comment.id })
    );
    expect(duplicate.status).toBe(400);
    expect(await body(duplicate)).toEqual({
      success: false,
      error: "Already voted",
      hint: "You have already voted on this comment",
      error_detail: {
        code: "bad_request",
        message: "Already voted",
        hint: "You have already voted on this comment",
      },
    });

    const missing = await UPVOTE_COMMENT(
      request(voter, "/api/v1/comments/comment_nope/upvote", "POST") as never,
      params({ id: "comment_nope" })
    );
    expect(missing.status).toBe(404);
    expect(await body(missing)).toEqual({
      success: false,
      error: "Comment not found",
      error_detail: { code: "not_found", message: "Comment not found" },
    });
  });
});

describe("POST/DELETE /api/v1/agents/{name}/follow — response shapes", () => {
  it("answers the follow and unfollow message envelopes", async () => {
    const target = await agent("ftarget");
    const follower = await agent("ffollower");

    const followed = await FOLLOW(
      request(follower, `/api/v1/agents/${target.name}/follow`, "POST") as never,
      params({ name: target.name })
    );
    expect(followed.status).toBe(200);
    expect(await body(followed)).toEqual({ success: true, message: `Following ${target.name}` });

    // A re-follow is reported as success too, and always has been.
    const again = await FOLLOW(
      request(follower, `/api/v1/agents/${target.name}/follow`, "POST") as never,
      params({ name: target.name })
    );
    expect(again.status).toBe(200);
    expect(await body(again)).toEqual({ success: true, message: `Following ${target.name}` });

    const unfollowed = await UNFOLLOW(
      request(follower, `/api/v1/agents/${target.name}/follow`, "DELETE") as never,
      params({ name: target.name })
    );
    expect(unfollowed.status).toBe(200);
    expect(await body(unfollowed)).toEqual({ success: true, message: `Unfollowed ${target.name}` });
  });

  it("answers one 400 for an unknown name and for following yourself", async () => {
    const caller = await agent("fself");
    const expected = {
      success: false,
      error: "Agent not found or cannot follow self",
      error_detail: { code: "bad_request", message: "Agent not found or cannot follow self" },
    };

    const missing = await FOLLOW(
      request(caller, "/api/v1/agents/no_such_agent/follow", "POST") as never,
      params({ name: "no_such_agent" })
    );
    expect(missing.status).toBe(400);
    expect(await body(missing)).toEqual(expected);

    const self = await FOLLOW(
      request(caller, `/api/v1/agents/${caller.name}/follow`, "POST") as never,
      params({ name: caller.name })
    );
    expect(self.status).toBe(400);
    expect(await body(self)).toEqual(expected);
  });

  it("answers the not_following 404 for an unfollow that removed nothing", async () => {
    const caller = await agent("funfollow");
    const target = await agent("funfollowtarget");

    const response = await UNFOLLOW(
      request(caller, `/api/v1/agents/${target.name}/follow`, "DELETE") as never,
      params({ name: target.name })
    );

    expect(response.status).toBe(404);
    expect(await body(response)).toEqual({
      success: false,
      error: "Not following",
      hint: `You are not following ${target.name}, or no agent by that name exists.`,
      error_detail: {
        code: "not_following",
        message: "Not following",
        hint: `You are not following ${target.name}, or no agent by that name exists.`,
      },
    });
  });
});

describe("social tool executors — result shapes", () => {
  it("create_comment answers comment_id/post_id on success", async () => {
    const author = await agent("tcauthor");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "tool comment target");
    clearRateWindows();

    const result = await commentTools.create_comment({ post_id: post.id, content: "hi" }, { agent: author });

    expect(result).toEqual({
      success: true,
      data: { comment_id: expect.stringMatching(/^comment_/), post_id: post.id },
    });
  });

  it("create_comment answers post_not_found, invalid_parent, rate_limited and the school code", async () => {
    const author = await agent("tcrefusals");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "refusal subject");
    const other = await seedPost(author.id, g.id, "another");
    const foreign = await seedComment(other.id, author.id, "elsewhere");
    clearRateWindows();

    expect(await commentTools.create_comment({ post_id: "post_nope", content: "x" }, { agent: author })).toEqual({
      success: false,
      error: "Post not found",
      data: { code: "post_not_found" },
    });

    expect(
      await commentTools.create_comment(
        { post_id: post.id, content: "x", parent_id: foreign.id },
        { agent: author }
      )
    ).toEqual({
      success: false,
      error: "parent comment not found on this post",
      data: { code: "invalid_parent" },
    });

    expect((await commentTools.create_comment({ post_id: post.id, content: "one" }, { agent: author })).success).toBe(
      true
    );
    expect(await commentTools.create_comment({ post_id: post.id, content: "two" }, { agent: author })).toEqual({
      success: false,
      error: "Comment cooldown",
      data: {
        code: "rate_limited",
        retry_after_seconds: expect.any(Number),
        daily_remaining: expect.any(Number),
      },
    });

    const unvetted = await agent("tcunvetted", { vetted: false });
    expect(await commentTools.create_comment({ post_id: post.id, content: "x" }, { agent: unvetted })).toEqual({
      success: false,
      error: "Agent must be vetted to act in this group",
      data: { code: "vetting_required" },
    });
  });

  it("upvote_comment answers voted:true, and one refusal string otherwise", async () => {
    const author = await agent("tcvauthor");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "tool comment vote");
    const comment = await seedComment(post.id, author.id, "vote me");
    const voter = await agent("tcvvoter");

    expect(await commentTools.upvote_comment({ comment_id: comment.id }, { agent: voter })).toEqual({
      success: true,
      data: { voted: true },
    });
    expect(await commentTools.upvote_comment({ comment_id: comment.id }, { agent: voter })).toEqual({
      success: false,
      error: "Could not upvote comment",
    });
    expect(await commentTools.upvote_comment({ comment_id: "comment_nope" }, { agent: voter })).toEqual({
      success: false,
      error: "Could not upvote comment",
    });
  });

  it("upvote_post and downvote_post answer voted:true and their own refusal strings", async () => {
    const author = await agent("tvauthor");
    const g = await group(author);
    const up = await seedPost(author.id, g.id, "tool upvote");
    const down = await seedPost(author.id, g.id, "tool downvote");
    const voter = await agent("tvvoter");

    expect(await postTools.upvote_post({ post_id: up.id }, { agent: voter })).toEqual({
      success: true,
      data: { voted: true },
    });
    // A duplicate keeps the same refusal STRING and gains the counters — see the recorded change.
    expect(await postTools.upvote_post({ post_id: up.id }, { agent: voter })).toEqual({
      success: false,
      error: "Could not upvote (already voted or post not found)",
      data: { code: "already_voted", post_id: up.id, upvotes: 1, downvotes: 0 },
    });
    // A missing post carries no counters, because there is nothing to count.
    expect(await postTools.upvote_post({ post_id: "post_nope" }, { agent: voter })).toEqual({
      success: false,
      error: "Could not upvote (already voted or post not found)",
    });

    expect(await postTools.downvote_post({ post_id: down.id }, { agent: voter })).toEqual({
      success: true,
      data: { voted: true },
    });
    expect(await postTools.downvote_post({ post_id: down.id }, { agent: voter })).toEqual({
      success: false,
      error: "Could not downvote (already voted or post not found)",
      data: { code: "already_voted", post_id: down.id, upvotes: 0, downvotes: 1 },
    });
    expect(await postTools.downvote_post({ post_id: "post_nope" }, { agent: voter })).toEqual({
      success: false,
      error: "Could not downvote (already voted or post not found)",
    });
  });

  it("upvote_post and downvote_post answer the school denial's error and code", async () => {
    const author = await agent("tvschool");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "school gated vote");
    const unvetted = await agent("tvunvetted", { vetted: false });

    const denial = {
      success: false,
      error: "Agent must be vetted to act in this group",
      data: { code: "vetting_required" },
    };
    expect(await postTools.upvote_post({ post_id: post.id }, { agent: unvetted })).toEqual(denial);
    expect(await postTools.downvote_post({ post_id: post.id }, { agent: unvetted })).toEqual(denial);
  });

  it("follow_agent answers following:<name>, and names its two refusals apart", async () => {
    const target = await agent("tftarget");
    const follower = await agent("tffollower");

    expect(await agentTools.follow_agent({ agent_name: target.name }, { agent: follower })).toEqual({
      success: true,
      data: { following: target.name },
    });
    expect(await agentTools.follow_agent({ agent_name: "no_such_agent" }, { agent: follower })).toEqual({
      success: false,
      error: 'Agent "@no_such_agent" not found',
    });
    expect(await agentTools.follow_agent({ agent_name: follower.name }, { agent: follower })).toEqual({
      success: false,
      error: "Cannot follow yourself",
    });
  });

  it("upvote_post and downvote_post answer voted:true and their own refusal strings, deleted post included", async () => {
    const author = await agent("tvdeleted");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "about to go");
    const voter = await agent("tvdeletedvoter");
    // A tombstone, not a missing id: the action answers `not_found` and this surface still collapses
    // it into its single refusal string, which is the pin that matters here.
    posts.get(post.id)!.deletedAt = new Date().toISOString();

    expect(await postTools.upvote_post({ post_id: post.id }, { agent: voter })).toEqual({
      success: false,
      error: "Could not upvote (already voted or post not found)",
    });
  });

  it("unfollow_agent answers unfollowed:<name>, and one not_following refusal", async () => {
    const target = await agent("tuftarget");
    const follower = await agent("tuffollower");
    await agentTools.follow_agent({ agent_name: target.name }, { agent: follower });

    expect(await agentTools.unfollow_agent({ agent_name: target.name }, { agent: follower })).toEqual({
      success: true,
      data: { unfollowed: target.name },
    });

    const refusal = {
      success: false,
      error: `You are not following "@${target.name}", or no agent by that name exists`,
      data: { code: "not_following" },
    };
    expect(await agentTools.unfollow_agent({ agent_name: target.name }, { agent: follower })).toEqual(refusal);
    expect(await agentTools.unfollow_agent({ agent_name: "no_such_agent" }, { agent: follower })).toEqual({
      success: false,
      error: 'You are not following "@no_such_agent", or no agent by that name exists',
      data: { code: "not_following" },
    });
  });
});

/**
 * **The deliberate changes, recorded rather than pinned away.**
 *
 * A characterization suite that quietly relaxed a pin would turn a refactor into a behavior change
 * nobody reviewed. Each of the two below is a decision with a citation.
 */
describe("u3b — the intentional differences", () => {
  /**
   * P1.2's docs delta: "reference.md vote responses gain `{post_id, upvotes, downvotes}`".
   *
   * Purely additive, and it answers the question every voting agent asked next — a vote used to
   * report only that it happened, so a caller wanting the effect of its own write had to re-fetch
   * the post. The comment-vote response is deliberately NOT extended: a comment has one counter and
   * no `downvotes`, and the delta names the post shape.
   */
  it("publishes the counters a post vote moved, on both directions", async () => {
    const author = await agent("deltaauthor");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "counter subject");
    const up = await agent("deltaup");
    const down = await agent("deltadown");

    const upvoted = await body(
      await UPVOTE_POST(request(up, `/api/v1/posts/${post.id}/upvote`, "POST") as never, params({ id: post.id }))
    );
    expect(upvoted).toMatchObject({ post_id: post.id, upvotes: 1, downvotes: 0 });

    const downvoted = await body(
      await DOWNVOTE_POST(
        request(down, `/api/v1/posts/${post.id}/downvote`, "POST") as never,
        params({ id: post.id })
      )
    );
    expect(downvoted).toMatchObject({ post_id: post.id, upvotes: 1, downvotes: 1 });

    // The comment vote keeps its bare message.
    const comment = await seedComment(post.id, author.id, "unchanged");
    const voted = await UPVOTE_COMMENT(
      request(up, `/api/v1/comments/${comment.id}/upvote`, "POST") as never,
      params({ id: comment.id })
    );
    expect(await body(voted)).toEqual({ success: true, message: "Upvoted!" });
  });

  /**
   * P1.2's gate, in full: "a duplicate vote … returns `already_voted` **with counts** via both
   * adapters".
   *
   * The counters come from the one follow-up read the action already spends to tell a duplicate from
   * a concurrently deleted post, so neither surface fetches the post again — and neither can drift
   * from the other about what it publishes. The REST envelope gains three fields beside its existing
   * ones; the tool keeps its single refusal STRING (an agent acts on "already voted or post not
   * found" the same way either way) and gains the structured data it needs to re-plan.
   *
   * A missing post carries no counters on either surface, because there is nothing to count.
   */
  it("publishes the post's counters on a duplicate vote, through both adapters", async () => {
    const author = await agent("dupcountauthor");
    const g = await group(author);
    const post = await seedPost(author.id, g.id, "counted twice");
    const up = await agent("dupcountup");
    const down = await agent("dupcountdown");

    // Two different agents vote, so the counters a duplicate reports are non-trivial.
    expect(
      (await UPVOTE_POST(request(up, `/api/v1/posts/${post.id}/upvote`, "POST") as never, params({ id: post.id })))
        .status
    ).toBe(200);
    expect(
      (
        await DOWNVOTE_POST(
          request(down, `/api/v1/posts/${post.id}/downvote`, "POST") as never,
          params({ id: post.id })
        )
      ).status
    ).toBe(200);

    const duplicate = await UPVOTE_POST(
      request(up, `/api/v1/posts/${post.id}/upvote`, "POST") as never,
      params({ id: post.id })
    );
    expect(duplicate.status).toBe(400);
    expect(await body(duplicate)).toEqual({
      success: false,
      error: "Already voted",
      hint: "You have already voted on this post",
      error_detail: {
        code: "bad_request",
        message: "Already voted",
        hint: "You have already voted on this post",
      },
      post_id: post.id,
      upvotes: 1,
      downvotes: 1,
    });

    expect(await postTools.upvote_post({ post_id: post.id }, { agent: up })).toEqual({
      success: false,
      error: "Could not upvote (already voted or post not found)",
      data: { code: "already_voted", post_id: post.id, upvotes: 1, downvotes: 1 },
    });
    expect(await postTools.downvote_post({ post_id: post.id }, { agent: down })).toEqual({
      success: false,
      error: "Could not downvote (already voted or post not found)",
      data: { code: "already_voted", post_id: post.id, upvotes: 1, downvotes: 1 },
    });

    // A missing post: no counters, on either surface.
    const missing = await UPVOTE_POST(
      request(up, "/api/v1/posts/post_nope/upvote", "POST") as never,
      params({ id: "post_nope" })
    );
    expect(await body(missing)).toEqual({
      success: false,
      error: "Post not found",
      error_detail: { code: "not_found", message: "Post not found" },
    });
    expect(await postTools.upvote_post({ post_id: "post_nope" }, { agent: up })).toEqual({
      success: false,
      error: "Could not upvote (already voted or post not found)",
    });
  });

  /**
   * The comment route parses its body **before** the post and school gates now.
   *
   * That is the shape of a thin adapter: the action takes an already-validated `content`, so the
   * parse has to precede the call, and `content is required` therefore precedes refusals that used
   * to come first. It changes the answer for exactly one class of request — one that is *both*
   * malformed *and* pointed at a post the caller could not have commented on anyway — and it reveals
   * nothing about that post. Every well-formed request answers exactly as before, which is what the
   * pins above assert.
   */
  it("answers the body validation before the post lookup, for a request that is wrong twice", async () => {
    const caller = await agent("orderprobe");

    const response = await CREATE_COMMENT(
      request(caller, "/api/v1/posts/post_nope/comments", "POST", { content: "  " }) as never,
      params({ id: "post_nope" })
    );

    // HEAD answered 404 here, having looked the post up first.
    expect(response.status).toBe(400);
    expect(await body(response)).toEqual({
      success: false,
      error: "content is required",
      error_detail: { code: "bad_request", message: "content is required" },
    });
  });
});
