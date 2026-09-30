import { searchPublicSafeMolt } from "@/lib/public-search";
import { listAgents, listGroups, searchPosts } from "@/lib/store";
import type { StoredAgent, StoredComment, StoredGroup, StoredPost } from "@/lib/store-types";

jest.mock("@/lib/store", () => ({
  listAgents: jest.fn(),
  listGroups: jest.fn(),
  searchPosts: jest.fn(),
}));

const mockListAgents = listAgents as jest.MockedFunction<typeof listAgents>;
const mockListGroups = listGroups as jest.MockedFunction<typeof listGroups>;
const mockSearchPosts = searchPosts as jest.MockedFunction<typeof searchPosts>;

function agent(overrides: Partial<StoredAgent>): StoredAgent {
  return {
    id: "agent_1",
    name: "alpha",
    displayName: undefined,
    description: "",
    apiKey: "key",
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function group(overrides: Partial<StoredGroup>): StoredGroup {
  return {
    id: "group_1",
    name: "general",
    displayName: "General",
    description: "",
    type: "group",
    ownerId: "agent_1",
    memberIds: [],
    moderatorIds: [],
    pinnedPostIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function post(overrides: Partial<StoredPost>): StoredPost {
  return {
    id: "post_1",
    title: "Launch memo",
    content: "",
    authorId: "agent_1",
    groupId: "group_1",
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

function comment(overrides: Partial<StoredComment>): StoredComment {
  return {
    id: "comment_1",
    postId: "post_1",
    authorId: "agent_1",
    content: "Sharp reply",
    upvotes: 0,
    createdAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("searchPublicSafeMolt", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockSearchPosts.mockResolvedValue([]);
    mockListAgents.mockResolvedValue([]);
    mockListGroups.mockResolvedValue([]);
  });

  it("returns an empty list for an empty query", async () => {
    await expect(searchPublicSafeMolt("   ")).resolves.toEqual([]);
    expect(mockSearchPosts).not.toHaveBeenCalled();
    expect(mockListAgents).not.toHaveBeenCalled();
    expect(mockListGroups).not.toHaveBeenCalled();
  });

  it("trims the query to 100 characters before searching posts", async () => {
    const longQuery = `${"memory".repeat(24)}  `;

    await searchPublicSafeMolt(longQuery, { type: "posts" });

    expect(mockSearchPosts).toHaveBeenCalledWith(expect.stringMatching(/^memory/), {
      type: "posts",
      limit: 30,
    });
    expect(mockSearchPosts.mock.calls[0][0]).toHaveLength(100);
  });

  it("filters by result type without calling unrelated store reads", async () => {
    mockListAgents.mockResolvedValue([
      agent({ id: "agent_2", name: "sable", displayName: "Sable", description: "Search scout" }),
    ]);

    const results = await searchPublicSafeMolt("sable", { type: "agents" });

    expect(results).toEqual([
      expect.objectContaining({
        id: "agent_2",
        type: "agent",
        href: "/u/sable",
      }),
    ]);
    expect(mockSearchPosts).not.toHaveBeenCalled();
    expect(mockListGroups).not.toHaveBeenCalled();
  });

  it("sorts exact and prefix title matches ahead of substring matches", async () => {
    mockListAgents.mockResolvedValue([
      agent({ id: "agent_substring", name: "trail-ai", displayName: "Trail AI" }),
      agent({ id: "agent_prefix", name: "atlas", displayName: "AI Atlas" }),
      agent({ id: "agent_exact", name: "ai", displayName: "Artificial Intelligence" }),
    ]);

    const results = await searchPublicSafeMolt("ai", { type: "agents" });

    expect(results.map((result) => result.id)).toEqual([
      "agent_exact",
      "agent_prefix",
      "agent_substring",
    ]);
  });

  it("keeps post and comment hrefs on stable post routes", async () => {
    const parentPost = post({ id: "post_123", title: "Memory search", commentCount: 2 });
    mockSearchPosts.mockResolvedValue([
      { type: "post", post: parentPost },
      {
        type: "comment",
        comment: comment({ id: "comment_456", postId: parentPost.id, content: "Memory reply" }),
        post: parentPost,
      },
    ]);

    const results = await searchPublicSafeMolt("memory", { type: "all" });

    expect(results).toEqual([
      expect.objectContaining({ type: "post", href: "/post/post_123" }),
      expect.objectContaining({ type: "comment", href: "/post/post_123" }),
    ]);
  });

  it("sorts stronger matches ahead of weaker matches across result types", async () => {
    mockSearchPosts.mockResolvedValue([
      { type: "post", post: post({ id: "post_exact", title: "Memory" }) },
    ]);
    mockListAgents.mockResolvedValue([
      agent({ id: "agent_substring", name: "archive-memory", displayName: "Archive Memory" }),
    ]);
    mockListGroups.mockResolvedValue([
      group({ id: "group_prefix", name: "memory-lab", displayName: "Memory Lab" }),
    ]);

    const results = await searchPublicSafeMolt("memory", { type: "all" });

    expect(results.map((result) => result.id)).toEqual([
      "post_exact",
      "group_prefix",
      "agent_substring",
    ]);
  });

  it("includes group matches when requested", async () => {
    mockListGroups.mockResolvedValue([
      group({ id: "group_safe", name: "safety", displayName: "Safety", description: "Alignment room" }),
    ]);

    const results = await searchPublicSafeMolt("align", { type: "groups" });

    expect(results).toEqual([
      expect.objectContaining({
        id: "group_safe",
        type: "group",
        href: "/g/safety",
      }),
    ]);
    expect(mockSearchPosts).not.toHaveBeenCalled();
    expect(mockListAgents).not.toHaveBeenCalled();
  });

  it("caps group scanning before filtering memory-backed groups", async () => {
    mockListGroups.mockResolvedValue([
      ...Array.from({ length: 500 }, (_, index) =>
        group({ id: `group_${index}`, name: `other-${index}`, displayName: `Other ${index}` })
      ),
      group({ id: "group_late", name: "needle", displayName: "Needle" }),
    ]);

    await expect(searchPublicSafeMolt("needle", { type: "groups" })).resolves.toEqual([]);
  });
});
