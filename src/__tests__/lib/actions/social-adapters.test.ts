/**
 * M11-2 u3b (P1.2) — the comment, vote and follow surfaces are **adapters**, and this is what makes
 * that checkable.
 *
 * The characterization file proves the wire shapes did not move; it cannot prove *where* they came
 * from, and a route that quietly kept its own copy of the school gate or the cooldown would pass it
 * forever. So this stubs the action modules and asserts each surface delegates: the action is called
 * with what the caller supplied, and the surface renders whatever the action answered — including
 * refusals the surface has no other way to produce, which is the only way to see that the
 * classification really moved.
 *
 * The second half is the P1.6 readiness check the plan asks for at this chunk: **no adapter may
 * import a mutating store export.** A source scan rather than a behavioural one, because that is the
 * only form that catches a re-introduction; the lint rule and the AST test that make it general
 * arrive with P1.6.
 *
 * @jest-environment node
 */
jest.mock("@/lib/actions/comments", () => ({
  createComment: jest.fn(),
  upvoteComment: jest.fn(),
}));
jest.mock("@/lib/actions/agents", () => ({
  followAgent: jest.fn(),
  unfollowAgent: jest.fn(),
}));
jest.mock("@/lib/actions/posts", () => ({
  createPost: jest.fn(),
  deletePost: jest.fn(),
  pinPost: jest.fn(),
  unpinPost: jest.fn(),
  upvotePost: jest.fn(),
  downvotePost: jest.fn(),
}));

import { readFileSync } from "fs";
import { join } from "path";

import { POST as CREATE_COMMENT } from "@/app/api/v1/posts/[id]/comments/route";
import { POST as UPVOTE_POST } from "@/app/api/v1/posts/[id]/upvote/route";
import { POST as DOWNVOTE_POST } from "@/app/api/v1/posts/[id]/downvote/route";
import { POST as UPVOTE_COMMENT } from "@/app/api/v1/comments/[id]/upvote/route";
import { POST as FOLLOW, DELETE as UNFOLLOW } from "@/app/api/v1/agents/[name]/follow/route";
import * as agentActions from "@/lib/actions/agents";
import * as commentActions from "@/lib/actions/comments";
import * as postActions from "@/lib/actions/posts";
import { executors as agentTools } from "@/lib/agent-tools/definitions/agents";
import { executors as commentTools } from "@/lib/agent-tools/definitions/comments";
import { executors as postTools } from "@/lib/agent-tools/definitions/posts";
import { createAgent, getAgentById, setAgentVetted } from "@/lib/store/agents/memory";
import type { StoredAgent, StoredComment, StoredPost } from "@/lib/store-types";
import { withMiddlewareHeaders } from "../../helpers/middleware-headers";

const REPO_ROOT = join(__dirname, "..", "..", "..", "..");

const createComment = commentActions.createComment as jest.Mock;
const upvoteComment = commentActions.upvoteComment as jest.Mock;
const upvotePost = postActions.upvotePost as jest.Mock;
const downvotePost = postActions.downvotePost as jest.Mock;
const followAgent = agentActions.followAgent as jest.Mock;
const unfollowAgent = agentActions.unfollowAgent as jest.Mock;

let seq = 0;

async function agent(): Promise<StoredAgent> {
  const created = await createAgent(`u3bad_${Date.now().toString(36)}_${(seq += 1)}`, "u3b adapter fixture");
  await setAgentVetted(created.id, "# adapter\n");
  return (await getAgentById(created.id))!;
}

const post = (id: string): StoredPost => ({
  id,
  title: "T",
  authorId: "author_a",
  groupId: "g",
  upvotes: 3,
  downvotes: 1,
  commentCount: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
});

const comment = (id: string): StoredComment => ({
  id,
  postId: "post_p",
  authorId: "author_a",
  content: "c",
  upvotes: 0,
  createdAt: "2026-01-01T00:00:00.000Z",
});

function request(url: string, method: string, caller: StoredAgent, body?: unknown): Request {
  return new Request(
    url,
    withMiddlewareHeaders({
      method,
      headers: { Authorization: `Bearer ${caller.apiKey}`, "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
  );
}

const params = <T extends Record<string, string>>(value: T) => ({ params: Promise.resolve(value) });

beforeEach(() => {
  jest.clearAllMocks();
});

describe("REST routes delegate to the actions", () => {
  it("POST /posts/{id}/comments passes the trimmed body and renders the action's comment", async () => {
    const caller = await agent();
    createComment.mockResolvedValue({ ok: true, data: { comment: comment("comment_x"), post: post("post_p") } });

    const response = await CREATE_COMMENT(
      request("https://safemolt.com/api/v1/posts/post_p/comments", "POST", caller, {
        content: "  hello  ",
        parent_id: "  comment_parent  ",
      }) as never,
      params({ id: "post_p" })
    );

    expect(createComment).toHaveBeenCalledWith({
      agent: expect.objectContaining({ id: caller.id }),
      postId: "post_p",
      content: "hello",
      parentId: "comment_parent",
    });
    expect((await response.json()).data).toMatchObject({ id: "comment_x" });
  });

  it("POST /posts/{id}/comments renders the rate-limit window the action measured", async () => {
    const caller = await agent();
    createComment.mockResolvedValue({
      ok: false,
      code: "rate_limited",
      message: "Comment cooldown",
      retryAfterSeconds: 17,
      dailyRemaining: 4,
    });

    const response = await CREATE_COMMENT(
      request("https://safemolt.com/api/v1/posts/post_p/comments", "POST", caller, { content: "x" }) as never,
      params({ id: "post_p" })
    );

    expect(response.status).toBe(429);
    // The numbers come from the ACTION, not from a second rate-limit read in the route.
    expect(await response.json()).toMatchObject({ retry_after_seconds: 17, daily_remaining: 4 });
  });

  it("the vote routes pass the post id and publish the counters the action returned", async () => {
    const caller = await agent();
    const data = { postId: "post_v", upvotes: 9, downvotes: 2, post: post("post_v") };
    upvotePost.mockResolvedValue({ ok: true, data });
    downvotePost.mockResolvedValue({ ok: true, data });

    const upvoted = await UPVOTE_POST(
      request("https://safemolt.com/api/v1/posts/post_v/upvote", "POST", caller) as never,
      params({ id: "post_v" })
    );
    const downvoted = await DOWNVOTE_POST(
      request("https://safemolt.com/api/v1/posts/post_v/downvote", "POST", caller) as never,
      params({ id: "post_v" })
    );

    expect(upvotePost).toHaveBeenCalledWith({ agent: expect.objectContaining({ id: caller.id }), postId: "post_v" });
    expect(downvotePost).toHaveBeenCalledWith({ agent: expect.objectContaining({ id: caller.id }), postId: "post_v" });
    expect(await upvoted.json()).toMatchObject({ post_id: "post_v", upvotes: 9, downvotes: 2 });
    expect(await downvoted.json()).toMatchObject({ post_id: "post_v", upvotes: 9, downvotes: 2 });
  });

  it("the vote routes answer 404 and 400 apart, which only the action can decide", async () => {
    const caller = await agent();
    upvotePost.mockResolvedValueOnce({ ok: false, code: "not_found", message: "Post not found" });
    const missing = await UPVOTE_POST(
      request("https://safemolt.com/api/v1/posts/post_v/upvote", "POST", caller) as never,
      params({ id: "post_v" })
    );
    expect(missing.status).toBe(404);

    upvotePost.mockResolvedValueOnce({ ok: false, code: "already_voted", message: "Already voted" });
    const duplicate = await UPVOTE_POST(
      request("https://safemolt.com/api/v1/posts/post_v/upvote", "POST", caller) as never,
      params({ id: "post_v" })
    );
    expect(duplicate.status).toBe(400);
    expect((await duplicate.json()).hint).toBe("You have already voted on this post");
  });

  it("the comment-vote route delegates and renders its own two refusals", async () => {
    const caller = await agent();
    upvoteComment.mockResolvedValueOnce({ ok: true, data: { commentId: "comment_c", postId: "post_p" } });

    const ok = await UPVOTE_COMMENT(
      request("https://safemolt.com/api/v1/comments/comment_c/upvote", "POST", caller) as never,
      params({ id: "comment_c" })
    );
    expect(upvoteComment).toHaveBeenCalledWith({
      agent: expect.objectContaining({ id: caller.id }),
      commentId: "comment_c",
    });
    expect(await ok.json()).toMatchObject({ success: true, message: "Upvoted!" });

    upvoteComment.mockResolvedValueOnce({ ok: false, code: "already_voted", message: "Already voted" });
    const duplicate = await UPVOTE_COMMENT(
      request("https://safemolt.com/api/v1/comments/comment_c/upvote", "POST", caller) as never,
      params({ id: "comment_c" })
    );
    expect(duplicate.status).toBe(400);
  });

  it("the follow route collapses the action's two refusals into its single 400", async () => {
    const caller = await agent();
    followAgent.mockResolvedValueOnce({ ok: true, data: { targetName: "target" } });
    const followed = await FOLLOW(
      request("https://safemolt.com/api/v1/agents/target/follow", "POST", caller) as never,
      params({ name: "target" })
    );
    expect(followAgent).toHaveBeenCalledWith({
      agent: expect.objectContaining({ id: caller.id }),
      targetName: "target",
    });
    expect(await followed.json()).toMatchObject({ success: true, message: "Following target" });

    for (const code of ["not_found", "bad_request"]) {
      followAgent.mockResolvedValueOnce({ ok: false, code, message: "whatever the action said" });
      const refused = await FOLLOW(
        request("https://safemolt.com/api/v1/agents/target/follow", "POST", caller) as never,
        params({ name: "target" })
      );
      expect(refused.status).toBe(400);
      // The route's own wording, not the action's message — which is the point of the code.
      expect((await refused.json()).error).toBe("Agent not found or cannot follow self");
    }
  });

  it("the unfollow route delegates and renders its not_following 404", async () => {
    const caller = await agent();
    unfollowAgent.mockResolvedValueOnce({ ok: false, code: "not_following", message: "Not following" });

    const response = await UNFOLLOW(
      request("https://safemolt.com/api/v1/agents/target/follow", "DELETE", caller) as never,
      params({ name: "target" })
    );

    expect(unfollowAgent).toHaveBeenCalledWith({
      agent: expect.objectContaining({ id: caller.id }),
      targetName: "target",
    });
    expect(response.status).toBe(404);
    expect((await response.json()).error_detail.code).toBe("not_following");
  });
});

describe("tool executors delegate to the same actions", () => {
  it("create_comment passes the caller's arguments and renders the action's refusals", async () => {
    const caller = await agent();
    createComment.mockResolvedValueOnce({
      ok: true,
      data: { comment: comment("comment_t"), post: post("post_p") },
    });

    const result = await commentTools.create_comment(
      { post_id: "post_p", content: "hi", parent_id: "comment_parent" },
      { agent: caller }
    );

    expect(createComment).toHaveBeenCalledWith({
      agent: caller,
      postId: "post_p",
      content: "hi",
      parentId: "comment_parent",
    });
    expect(result).toEqual({ success: true, data: { comment_id: "comment_t", post_id: "post_p" } });

    // This surface's own spelling of `not_found`, which differs from the route's on purpose.
    createComment.mockResolvedValueOnce({ ok: false, code: "not_found", message: "Post not found" });
    expect(await commentTools.create_comment({ post_id: "post_p", content: "x" }, { agent: caller })).toEqual({
      success: false,
      error: "Post not found",
      data: { code: "post_not_found" },
    });
  });

  it("upvote_comment, upvote_post and downvote_post delegate and collapse their refusals", async () => {
    const caller = await agent();
    upvoteComment.mockResolvedValueOnce({ ok: true, data: { commentId: "c", postId: "p" } });
    upvotePost.mockResolvedValueOnce({ ok: true, data: { postId: "p", upvotes: 1, downvotes: 0, post: post("p") } });
    downvotePost.mockResolvedValueOnce({ ok: true, data: { postId: "p", upvotes: 1, downvotes: 1, post: post("p") } });

    expect(await commentTools.upvote_comment({ comment_id: "c" }, { agent: caller })).toEqual({
      success: true,
      data: { voted: true },
    });
    expect(await postTools.upvote_post({ post_id: "p" }, { agent: caller })).toEqual({
      success: true,
      data: { voted: true },
    });
    expect(await postTools.downvote_post({ post_id: "p" }, { agent: caller })).toEqual({
      success: true,
      data: { voted: true },
    });
    expect(upvoteComment).toHaveBeenCalledWith({ agent: caller, commentId: "c" });
    expect(upvotePost).toHaveBeenCalledWith({ agent: caller, postId: "p" });
    expect(downvotePost).toHaveBeenCalledWith({ agent: caller, postId: "p" });

    // `not_found` and `already_voted` share one string here — the contract this surface has always
    // published — while the school gate keeps its code.
    for (const code of ["not_found", "already_voted"]) {
      upvotePost.mockResolvedValueOnce({ ok: false, code, message: "m" });
      expect(await postTools.upvote_post({ post_id: "p" }, { agent: caller })).toEqual({
        success: false,
        error: "Could not upvote (already voted or post not found)",
      });
    }
    upvotePost.mockResolvedValueOnce({ ok: false, code: "vetting_required", message: "vet me" });
    expect(await postTools.upvote_post({ post_id: "p" }, { agent: caller })).toEqual({
      success: false,
      error: "vet me",
      data: { code: "vetting_required" },
    });
  });

  it("follow_agent publishes the action's two refusals apart, and unfollow_agent collapses its one", async () => {
    const caller = await agent();
    followAgent.mockResolvedValueOnce({ ok: true, data: { targetName: "target" } });
    expect(await agentTools.follow_agent({ agent_name: "target" }, { agent: caller })).toEqual({
      success: true,
      data: { following: "target" },
    });
    expect(followAgent).toHaveBeenCalledWith({ agent: caller, targetName: "target" });

    followAgent.mockResolvedValueOnce({ ok: false, code: "not_found", message: 'Agent "@target" not found' });
    expect(await agentTools.follow_agent({ agent_name: "target" }, { agent: caller })).toEqual({
      success: false,
      error: 'Agent "@target" not found',
    });
    followAgent.mockResolvedValueOnce({ ok: false, code: "bad_request", message: "Cannot follow yourself" });
    expect(await agentTools.follow_agent({ agent_name: "target" }, { agent: caller })).toEqual({
      success: false,
      error: "Cannot follow yourself",
    });

    unfollowAgent.mockResolvedValueOnce({ ok: true, data: { targetName: "target" } });
    expect(await agentTools.unfollow_agent({ agent_name: "target" }, { agent: caller })).toEqual({
      success: true,
      data: { unfollowed: "target" },
    });
    expect(unfollowAgent).toHaveBeenCalledWith({ agent: caller, targetName: "target" });
  });
});

/**
 * P1.6 readiness, applied to the files this chunk migrated.
 *
 * The boundary's general enforcement is P1.6's and needs the store export manifest that does not
 * exist yet. What can be asserted today is the property these files must already have: the comment,
 * vote and follow mutations are reached through an action and through nothing else.
 */
describe("adapters import no mutating social store export", () => {
  const ADAPTERS: Array<[file: string, actionModule: string]> = [
    ["src/app/api/v1/posts/[id]/comments/route.ts", "@/lib/actions/comments"],
    ["src/app/api/v1/comments/[id]/upvote/route.ts", "@/lib/actions/comments"],
    ["src/app/api/v1/posts/[id]/upvote/route.ts", "@/lib/actions/posts"],
    ["src/app/api/v1/posts/[id]/downvote/route.ts", "@/lib/actions/posts"],
    ["src/app/api/v1/agents/[name]/follow/route.ts", "@/lib/actions/agents"],
    ["src/lib/agent-tools/definitions/comments.ts", "@/lib/actions/comments"],
    ["src/lib/agent-tools/definitions/posts.ts", "@/lib/actions/posts"],
    ["src/lib/agent-tools/definitions/agents.ts", "@/lib/actions/agents"],
  ];
  /** The six mutations this chunk moved behind the action layer. */
  const MUTATIONS = [
    "createComment",
    "upvoteComment",
    "upvotePost",
    "downvotePost",
    "followAgent",
    "unfollowAgent",
  ];

  it.each(ADAPTERS)("%s takes them from %s", (file, actionModule) => {
    const source = readFileSync(join(REPO_ROOT, file), "utf8");
    const imports = [...source.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+"([^"]+)"/g)].map(
      ([, names, module]) => ({
        module,
        names: names.split(",").map((name) => name.trim().split(/\s+as\s+/)[0].trim()),
      })
    );

    for (const mutation of MUTATIONS) {
      const from = imports.filter((entry) => entry.names.includes(mutation)).map((entry) => entry.module);
      // Either the file does not use the mutation, or it takes it from an action module — never
      // from `@/lib/store`.
      expect(from.filter((module) => module.startsWith("@/lib/store"))).toEqual([]);
      if (from.length > 0) expect(from).toContain(actionModule);
    }
  });
});
