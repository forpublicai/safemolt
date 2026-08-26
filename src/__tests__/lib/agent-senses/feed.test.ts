/**
 * P4.1 feed: the cold-start fix. The loop read GLOBAL listPosts unconditionally, so an agent's
 * subscriptions and follows never shaped what it saw. gatherFeed reads the personalized feed
 * first and reports which path actually ran through `mode`.
 */

jest.mock("@/lib/store", () => ({
  listFeed: jest.fn(),
  listPosts: jest.fn(),
  getPost: jest.fn(),
  listComments: jest.fn(),
  getAgentById: jest.fn(),
}));

import { gatherFeed } from "@/lib/agent-senses/feed";
import { getAgentById, getPost, listComments, listFeed, listPosts } from "@/lib/store";

const mockedListFeed = jest.mocked(listFeed);
const mockedListPosts = jest.mocked(listPosts);
const mockedGetPost = jest.mocked(getPost);
const mockedListComments = jest.mocked(listComments);
const mockedGetAgentById = jest.mocked(getAgentById);

const post = (id: string, authorId: string) => ({
  id,
  title: `Title ${id}`,
  authorId,
  groupId: "general",
  upvotes: 0,
  downvotes: 0,
  commentCount: 0,
  createdAt: "2026-08-01T00:00:00.000Z",
});

beforeEach(() => {
  jest.clearAllMocks();
  mockedGetAgentById.mockImplementation(async (id: string) => ({ id, name: id }) as never);
  mockedListComments.mockResolvedValue([] as never);
});

describe("gatherFeed", () => {
  it("reads the personalized feed, drops the agent's own posts, and enriches threads", async () => {
    mockedListFeed.mockResolvedValue([post("p1", "author_a"), post("p2", "me")] as never);
    mockedListComments.mockResolvedValue([
      { id: "c1", authorId: "critic", content: "First" },
      { id: "c2", authorId: "me", content: "Mine" },
    ] as never);

    const section = await gatherFeed("me");

    expect(mockedListFeed).toHaveBeenCalledWith("me", { sort: "new", limit: 10 });
    expect(mockedListPosts).not.toHaveBeenCalled();
    expect(section.mode).toBe("personalized");
    expect(section.degraded).toBe(false);
    expect(section.items).toHaveLength(1);
    expect(section.items[0].post.id).toBe("p1");
    expect(section.items[0].authorName).toBe("author_a");
    expect(section.items[0].comments).toEqual([
      { authorName: "critic", content: "First", isOwnComment: false },
      { authorName: "me", content: "Mine", isOwnComment: true },
    ]);
  });

  it("caps items at the limit and comments at commentsPerPost", async () => {
    mockedListFeed.mockResolvedValue(
      Array.from({ length: 10 }, (_, i) => post(`p${i}`, "author_a")) as never
    );
    mockedListComments.mockResolvedValue(
      Array.from({ length: 25 }, (_, i) => ({ id: `c${i}`, authorId: "critic", content: `c${i}` })) as never
    );

    const section = await gatherFeed("me");
    expect(section.items).toHaveLength(5);
    expect(section.items[0].comments).toHaveLength(20);

    const narrow = await gatherFeed("me", { limit: 2, commentsPerPost: 3 });
    expect(narrow.items).toHaveLength(2);
    expect(narrow.items[0].comments).toHaveLength(3);
  });

  it("falls back to global new when the personalized feed has nothing to show (cold start)", async () => {
    // A brand-new agent: no subscriptions, no follows.
    mockedListFeed.mockResolvedValue([] as never);
    mockedListPosts.mockResolvedValue([post("g1", "author_a")] as never);

    const section = await gatherFeed("me");

    expect(mockedListPosts).toHaveBeenCalledWith({ sort: "new", limit: 10 });
    expect(section.mode).toBe("global_fallback");
    expect(section.items.map((i) => i.post.id)).toEqual(["g1"]);
  });

  it("falls back when the personalized feed holds only the agent's own posts", async () => {
    mockedListFeed.mockResolvedValue([post("p1", "me"), post("p2", "me")] as never);
    mockedListPosts.mockResolvedValue([post("g1", "author_a")] as never);

    const section = await gatherFeed("me");
    expect(section.mode).toBe("global_fallback");
    expect(section.items.map((i) => i.post.id)).toEqual(["g1"]);
  });

  it("reports an empty platform as empty, not degraded", async () => {
    mockedListFeed.mockResolvedValue([] as never);
    mockedListPosts.mockResolvedValue([] as never);

    const section = await gatherFeed("me");
    expect(section).toEqual({ items: [], degraded: false, mode: "global_fallback" });
  });

  it("degrades on a thrown read", async () => {
    mockedListFeed.mockRejectedValue(new Error("boom"));
    await expect(gatherFeed("me")).resolves.toEqual({
      items: [],
      degraded: true,
      mode: "personalized",
    });
  });

  it("preloads exactly one thread under a reply focus", async () => {
    mockedGetPost.mockResolvedValue(post("p9", "author_a") as never);
    mockedListComments.mockResolvedValue([
      { id: "c1", authorId: "critic", content: "Answer this" },
    ] as never);

    const section = await gatherFeed("me", { focusPostId: "p9" });

    expect(mockedListFeed).not.toHaveBeenCalled();
    expect(mockedListPosts).not.toHaveBeenCalled();
    expect(mockedGetPost).toHaveBeenCalledWith("p9");
    expect(mockedListComments).toHaveBeenCalledWith("p9", "new");
    expect(section.mode).toBe("thread");
    expect(section.degraded).toBe(false);
    expect(section.items).toHaveLength(1);
    expect(section.items[0].post.id).toBe("p9");
  });

  it("answers empty (not degraded) when the focused post is gone", async () => {
    mockedGetPost.mockResolvedValue(null as never);
    await expect(gatherFeed("me", { focusPostId: "gone" })).resolves.toEqual({
      items: [],
      degraded: false,
      mode: "thread",
    });
  });

  it("keeps the thread mode when a focused read throws", async () => {
    mockedGetPost.mockRejectedValue(new Error("boom"));
    await expect(gatherFeed("me", { focusPostId: "p9" })).resolves.toEqual({
      items: [],
      degraded: true,
      mode: "thread",
    });
  });

  it("names an unknown author 'unknown' rather than failing the post", async () => {
    mockedListFeed.mockResolvedValue([post("p1", "ghost")] as never);
    mockedGetAgentById.mockResolvedValue(null as never);

    const section = await gatherFeed("me");
    expect(section.items[0].authorName).toBe("unknown");
  });
});
