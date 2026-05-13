jest.mock("@/lib/store", () => ({
  listPosts: jest.fn(),
}));

jest.mock("rss-parser", () => jest.fn());

import Parser from "rss-parser";
import { listPosts } from "@/lib/store";
import {
  __resetNewsCacheForTests,
  buildNewsStoryId,
  getNewsItems,
  normalizeNewsUrl,
} from "@/lib/rss";
import type { StoredPost } from "@/lib/store-types";

const mockedListPosts = listPosts as jest.MockedFunction<typeof listPosts>;
const mockedParser = Parser as unknown as jest.Mock;

function post(overrides: Partial<StoredPost>): StoredPost {
  return {
    id: "post_default",
    title: "Default post",
    content: undefined,
    url: undefined,
    authorId: "agent_1",
    groupId: "group_1",
    upvotes: 0,
    downvotes: 0,
    commentCount: 0,
    createdAt: "2026-05-13T10:00:00.000Z",
    ...overrides,
  };
}

function mockFeed(item: { title?: string; link?: string; source?: string; contentSnippet?: string; isoDate?: string }) {
  mockedParser.mockImplementation(() => ({
    parseURL: jest.fn(async () => ({ items: [item] })),
  }));
}

describe("rss news canonicalization", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __resetNewsCacheForTests();
    jest.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-13T12:00:00.000Z"));
    mockedListPosts.mockResolvedValue([]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    Reflect.deleteProperty(global, "fetch");
  });

  it("strips common tracking parameters and hashes while preserving path case", () => {
    expect(normalizeNewsUrl("https://Example.COM/Some/Path?utm_source=x&fbclid=abc&keep=1#section")).toBe(
      "https://example.com/Some/Path?keep=1"
    );
  });

  it("builds stable story IDs from canonical URLs", () => {
    const first = buildNewsStoryId({
      canonicalUrl: "https://example.com/story",
      title: "Ignored if URL exists",
      source: "Example",
      pubDate: "2026-05-13T10:00:00.000Z",
    });
    const second = buildNewsStoryId({
      canonicalUrl: "https://example.com/story",
      title: "Different title",
      source: "Other",
      pubDate: "2026-05-14T10:00:00.000Z",
    });

    expect(first).toMatch(/^news_[0-9a-f]{16}$/);
    expect(second).toBe(first);
  });

  it("falls back to normalized title/source/day when URL is unavailable", () => {
    expect(buildNewsStoryId({ title: "AI Agents, Everywhere!", source: "AP", pubDate: "2026-05-13T10:00:00.000Z" })).toBe(
      buildNewsStoryId({ title: "AI agents everywhere", source: "AP", pubDate: "2026-05-13T23:00:00.000Z" })
    );
  });

  it("uses title/source/day story IDs when a feed URL is not usable HTTP(S)", async () => {
    mockFeed({
      title: "AI Agents Everywhere!",
      link: "mailto:tips@example.com",
      source: "AP",
      contentSnippet: "A useful summary",
      isoDate: "2026-05-13T10:00:00.000Z",
    });

    const [item] = await getNewsItems(1);

    expect(item.canonicalizationConfidence).toBe("fallback");
    expect(item.storyId).toBe(buildNewsStoryId({ title: "AI agents everywhere", source: "AP", pubDate: "2026-05-13T10:00:00.000Z" }));
  });

  it("resolves bounded Google News redirects into canonical URLs", async () => {
    mockFeed({
      title: "Redirected story",
      link: "https://news.google.com/rss/articles/abc?utm_source=rss",
      source: "Google News",
      isoDate: "2026-05-13T10:00:00.000Z",
    });
    const fetchSpy = jest.fn(async () => ({
      url: "https://Example.com/Story?utm_campaign=x&keep=1#frag",
    } as Response));
    Object.defineProperty(global, "fetch", { value: fetchSpy, configurable: true });

    const [item] = await getNewsItems(1);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(item.canonicalizationConfidence).toBe("resolved");
    expect(item.canonicalUrl).toBe("https://example.com/Story?keep=1");
  });

  it("does not resolve redirects for non-Google news URLs", async () => {
    mockFeed({
      title: "Direct story",
      link: "https://example.com/direct?utm_source=rss",
      source: "Example",
      isoDate: "2026-05-13T10:00:00.000Z",
    });
    const fetchSpy = jest.fn(async () => ({ url: "https://other.test/" } as Response));
    Object.defineProperty(global, "fetch", { value: fetchSpy, configurable: true });

    const [item] = await getNewsItems(1);

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(item.canonicalizationConfidence).toBe("normalized");
    expect(item.canonicalUrl).toBe("https://example.com/direct");
  });

  it("matches existing discussions by normalized post URL, embedded content URL, then title fallback with ranking and cap", async () => {
    mockFeed({
      title: "Agents Discuss Regulation!",
      link: "https://example.com/story?utm_source=rss#frag",
      source: "Example",
      contentSnippet: "A useful summary",
      isoDate: "2026-05-13T10:00:00.000Z",
    });
    mockedListPosts.mockResolvedValue([
      post({
        id: "post_url_low",
        title: "URL low",
        url: "https://example.com/story?fbclid=abc",
        commentCount: 1,
        upvotes: 100,
        createdAt: "2026-05-13T10:00:00.000Z",
      }),
      post({
        id: "post_content_mid",
        title: "Content mid",
        content: "Discussing https://example.com/story?utm_campaign=x today",
        commentCount: 5,
        upvotes: 1,
        createdAt: "2026-05-13T09:00:00.000Z",
      }),
      post({
        id: "post_title_high",
        title: "Agents discuss regulation",
        commentCount: 5,
        upvotes: 9,
        createdAt: "2026-05-13T08:00:00.000Z",
      }),
      post({
        id: "post_tiebreak_newer",
        title: "Agents discuss regulation",
        commentCount: 5,
        upvotes: 9,
        createdAt: "2026-05-13T11:00:00.000Z",
      }),
      post({
        id: "post_old_ignored",
        title: "Agents discuss regulation",
        commentCount: 99,
        upvotes: 99,
        createdAt: "2026-04-01T10:00:00.000Z",
      }),
    ]);

    const [item] = await getNewsItems(1);

    expect(item.canonicalUrl).toBe("https://example.com/story");
    expect(item.existingDiscussions?.map((discussion) => discussion.postId)).toEqual([
      "post_tiebreak_newer",
      "post_title_high",
      "post_content_mid",
    ]);
    expect(item.existingDiscussions).toHaveLength(3);
  });
});
