/**
 * @jest-environment node
 */
import { NextRequest } from "next/server";
import { GET as getActivity } from "@/app/api/activity/route";
import { GET as getActivityContext } from "@/app/api/activity/[kind]/[id]/context/route";
import { getActivityTrailPage } from "@/lib/activity";
import { generateOrGetActivityContext } from "@/lib/activity-context";

jest.mock("@/lib/activity", () => ({
  getActivityTrailPage: jest.fn(),
}));

jest.mock("@/lib/activity-context", () => ({
  generateOrGetActivityContext: jest.fn(),
}));

const mockedGetActivityTrailPage = getActivityTrailPage as jest.MockedFunction<typeof getActivityTrailPage>;
const mockedGenerateOrGetActivityContext = generateOrGetActivityContext as jest.MockedFunction<typeof generateOrGetActivityContext>;

describe("activity cache headers", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("caches the paginated activity feed at the edge", async () => {
    mockedGetActivityTrailPage.mockResolvedValue({
      activities: [],
      hasMore: false,
      stats: { lastActivityLabel: "no activity yet", agentsEnrolled: 0 },
    });

    const response = await getActivity(new NextRequest("http://localhost/api/activity"));

    expect(response.headers.get("Cache-Control")).toBe("s-maxage=10, stale-while-revalidate=60");
    expect(response.headers.get("Server-Timing")).toContain("activity_feed_page;dur=");
  });

  it("caches already-stored activity context", async () => {
    mockedGenerateOrGetActivityContext.mockResolvedValue({
      content: "cached",
      cached: true,
      enriched: true,
    });

    const response = await getActivityContext(new Request("http://localhost/api/activity/post/p1/context"), {
      params: Promise.resolve({ kind: "post", id: "p1" }),
    });

    expect(response.headers.get("Cache-Control")).toBe("s-maxage=60, stale-while-revalidate=300");
    expect(response.headers.get("Server-Timing")).toContain("context_get_or_generate;dur=");
  });

  it("keeps first-write activity context uncached", async () => {
    mockedGenerateOrGetActivityContext.mockResolvedValue({
      content: "fresh",
      cached: false,
      enriched: false,
    });

    const response = await getActivityContext(new Request("http://localhost/api/activity/post/p1/context"), {
      params: Promise.resolve({ kind: "post", id: "p1" }),
    });

    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
