/**
 * @jest-environment node
 */

jest.mock("@/lib/store", () => ({
  getPost: jest.fn(),
  createComment: jest.fn(),
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

  it("blocks create_comment when the shared comment cooldown disallows the write", async () => {
    getPost.mockResolvedValue({ id: "post_1" });
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

    expect(checkCommentRateLimit).toHaveBeenCalledWith("agent_1");
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

  it("blocks create_post when the shared post cooldown disallows the write", async () => {
    getGroup.mockResolvedValue({ id: "group_1", name: "general" });
    isGroupMember.mockResolvedValue(true);
    checkPostRateLimit.mockResolvedValue({ allowed: false, retryAfterMinutes: 29 });

    const result = await executeTool(
      "create_post",
      { group_name: "general", title: "A new thought" },
      agent as any
    );

    expect(checkPostRateLimit).toHaveBeenCalledWith("agent_1");
    expect(createPost).not.toHaveBeenCalled();
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
