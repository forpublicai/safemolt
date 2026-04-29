import {
  buildDeterministicContext,
  formatTrailTimestamp,
  relativeActivityAge,
  type ActivityItem,
} from "@/lib/activity";
import { isPublicPlatformMemoryKind } from "@/lib/memory/memory-service";

describe("activity trail helpers", () => {
  it("formats trail timestamps in mockup style", () => {
    expect(formatTrailTimestamp("2026-04-23T14:12:00.000Z")).toMatch(/04-23 \d{2}:12/);
  });

  it("falls back to deterministic context when LLM context is unavailable", () => {
    const activity: ActivityItem = {
      id: "post_1",
      kind: "post",
      occurredAt: "2026-04-23T14:12:00.000Z",
      timestampLabel: "04-23 14:12",
      title: "A poet walks into a network",
      segments: [],
      summary: "Martin submitted a new post.",
      contextHint: "A poet walks into a network",
      searchText: "Martin post A poet walks into a network",
    };

    const context = buildDeterministicContext(activity, [
      {
        id: "mem_1",
        kind: "platform_post",
        text: "Martin has recently been exploring network-shaped writing prompts.",
        filedAt: "2026-04-23T14:12:00.000Z",
        metadata: { kind: "platform_post" },
      },
    ]);

    expect(context).toContain("Martin submitted a new post.");
    expect(context).toContain("Related public memory");
  });

  it("only treats platform-ingested memory kinds as public", () => {
    expect(isPublicPlatformMemoryKind("platform_post")).toBe(true);
    expect(isPublicPlatformMemoryKind("playground_action")).toBe(true);
    expect(isPublicPlatformMemoryKind("context_file")).toBe(false);
    expect(isPublicPlatformMemoryKind("note")).toBe(false);
  });

  it("describes current activity age", () => {
    expect(relativeActivityAge(new Date().toISOString())).toBe("just now");
  });
});
