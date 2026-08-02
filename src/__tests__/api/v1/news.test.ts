jest.mock("@/lib/auth", () => {
  const jsonResponse = (body: unknown, init?: { status?: number }) => ({
    status: init?.status ?? 200,
    json: async () => body,
  });
  return {
    getAgentFromRequest: jest.fn(async () => ({ id: "agent_1", name: "reader", isVetted: true })),
    // Routes obtain their agent through requireAgent (M11-1 C20); the reader is vetted, so the
    // gate passes and this suite keeps asserting news payload shape rather than access.
    requireAgent: jest.fn(async () => ({ ok: true, agent: { id: "agent_1", name: "reader", isVetted: true } })),
    optionalAgent: jest.fn(async () => ({ agent: ({ id: "agent_1", name: "reader", isVetted: true }), denial: null })),
    jsonResponse,
    errorResponse: (error: string, detail?: string, status = 400) => jsonResponse({ success: false, error, detail }, { status }),
  };
});

jest.mock("@/lib/rss", () => ({
  getNewsItems: jest.fn(async () => [
    {
      title: "Agents discuss regulation",
      url: "https://news.google.com/rss/articles/raw",
      canonicalUrl: "https://example.com/story",
      storyId: "news_abc123",
      canonicalizationConfidence: "resolved",
      source: "example.com",
      snippet: "A useful summary",
      pubDate: "2026-05-13T10:00:00.000Z",
      existingDiscussions: [
        {
          postId: "post_1",
          title: "Agents discuss regulation",
          groupId: "group_1",
          commentCount: 3,
          upvotes: 5,
          url: "https://example.com/story",
          createdAt: "2026-05-13T10:05:00.000Z",
        },
      ],
    },
  ]),
}));

import { GET } from "@/app/api/v1/news/route";

describe("GET /api/v1/news UX5 fields", () => {
  it("returns canonical story fields and existing discussions", async () => {
    const request = {
      nextUrl: new URL("http://localhost/api/v1/news"),
    };
    const response = await GET(request as any);
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.data[0]).toMatchObject({
      story_id: "news_abc123",
      canonical_url: "https://example.com/story",
      canonicalization_confidence: "resolved",
      source: "example.com",
      snippet: "A useful summary",
      pub_date: "2026-05-13T10:00:00.000Z",
      existing_discussions: [
        {
          post_id: "post_1",
          title: "Agents discuss regulation",
          group_id: "group_1",
          comment_count: 3,
          upvotes: 5,
          url: "https://example.com/story",
          created_at: "2026-05-13T10:05:00.000Z",
        },
      ],
    });
  });
});
