/**
 * @jest-environment node
 */

jest.mock("@/lib/store", () => ({
  getPost: jest.fn(),
  createComment: jest.fn(),
  createCommentWithOutcome: jest.fn(),
  checkCommentRateLimit: jest.fn(),
  getGroup: jest.fn(),
  isGroupMember: jest.fn(),
  checkPostRateLimit: jest.fn(),
  createPost: jest.fn(),
  upvotePost: jest.fn(),
  downvotePost: jest.fn(),
  deletePost: jest.fn(),
  pinPost: jest.fn(),
  unpinPost: jest.fn(),
  searchPosts: jest.fn(),
  listFeed: jest.fn(),
  getAgentById: jest.fn(),
}));

import { executeTool } from "@/lib/agent-tools";

const {
  getPost,
  createComment,
  createCommentWithOutcome,
  checkCommentRateLimit,
  getGroup,
  isGroupMember,
  checkPostRateLimit,
  createPost,
} = require("@/lib/store");

const agent = {
  id: "agent_1",
  name: "arlo_sketches",
  displayName: "Arlo",
  isVetted: true,
};

describe("social agent tool write policy", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  /**
   * The comment cooldown refusal, now decided **inside the insert** (M11-1 C16) and CLASSIFIED from
   * that statement's own flags (M11-2 P1.2).
   *
   * The tool used to consult `checkCommentRateLimit` first and skip the store when it said no. That
   * pre-check was advisory, and refusing on it was worse than redundant: a post deleted mid-flight
   * then answered "cooldown" where the decisive statement — holding the post lock — says "not
   * found". So the statement is always reached, it reports `admitted: false`, and the checker is
   * consulted afterwards for the WINDOW alone. The refusal body an agent sees is unchanged.
   */
  it("blocks create_comment when the shared comment cooldown disallows the write", async () => {
    getPost.mockResolvedValue({ id: "post_1" });
    createCommentWithOutcome.mockResolvedValue({
      comment: null,
      postExists: true,
      parentValid: true,
      admitted: false,
    });
    checkCommentRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 12,
      dailyRemaining: 49,
    });

    const result = await executeTool(
      "create_comment",
      { post_id: "post_1", content: "A concise reply." },
      agent as any
    );

    // The statement decided the refusal; the checker only measured the window it publishes.
    expect(createCommentWithOutcome).toHaveBeenCalled();
    expect(checkCommentRateLimit).toHaveBeenCalledWith("agent_1");
    // Nothing was written: the store's own claim refused, which is the point of C16.
    expect(createComment).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "Comment cooldown",
      data: {
        code: "rate_limited",
        retry_after_seconds: 12,
        daily_remaining: 49,
      },
    });
  });

  /**
   * The cooldown refusal, now decided **inside the insert** (M11-2 P1.1).
   *
   * The tool used to consult `checkPostRateLimit` first and skip the store when it said no. That
   * pre-check was advisory and the route never had it: M11-1 C16 moved the window into the insert
   * statement, where a concurrent post from the same agent cannot slip past it, and left the checker
   * as the thing that computes `retry_after_minutes` for the refusal body. Both surfaces now share
   * the one path — the store is asked, refuses atomically (charging nothing, writing nothing,
   * emitting nothing), and the window is read once afterwards for the hint.
   *
   * The tool's answer is byte-identical either way, which is what this still asserts.
   */
  it("refuses create_post through the store's own claim, and reads the window for the hint", async () => {
    getGroup.mockResolvedValue({ id: "group_1", name: "general" });
    isGroupMember.mockResolvedValue(true);
    // The store's atomic claim refusing the insert — M11-1 C16's null.
    createPost.mockResolvedValue(null);
    checkPostRateLimit.mockResolvedValue({ allowed: false, retryAfterMinutes: 29 });

    const result = await executeTool(
      "create_post",
      { group_name: "general", title: "A new thought" },
      agent as any
    );

    expect(createPost).toHaveBeenCalled();
    expect(checkPostRateLimit).toHaveBeenCalledWith("agent_1");
    expect(result).toEqual({
      success: false,
      error: "Post cooldown",
      data: {
        code: "rate_limited",
        retry_after_minutes: 29,
      },
    });
  });

  it("blocks create_post when the agent is not a group member", async () => {
    getGroup.mockResolvedValue({ id: "group_1", name: "general", type: "standard" });
    isGroupMember.mockResolvedValue(false);

    const result = await executeTool(
      "create_post",
      { group_name: "general", title: "A new thought" },
      agent as any
    );

    expect(isGroupMember).toHaveBeenCalledWith("agent_1", "group_1");
    expect(checkPostRateLimit).not.toHaveBeenCalled();
    expect(createPost).not.toHaveBeenCalled();
    expect(result).toEqual({
      success: false,
      error: "Forbidden",
      data: { code: "not_group_member" },
    });
  });
});
