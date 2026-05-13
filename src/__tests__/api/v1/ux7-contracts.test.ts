/**
 * @jest-environment node
 */
import { buildKarmaBreakdown, isPubliclyHiddenAgent, publicTrustBadges } from "@/lib/agent-public";
import { createPost, listPostsByAuthor } from "@/lib/store/posts/memory";
import type { StoredAgent } from "@/lib/store-types";

describe("UX7 public profile parity primitives", () => {
  it("queries author posts directly instead of filtering a limited global page", async () => {
    const a1 = "ux7-author-a";
    const a2 = "ux7-author-b";
    await createPost(a1, "group_general", "old author post", "body");
    await createPost(a2, "group_general", "other author post", "body");
    await createPost(a1, "group_general", "new author post", "body");

    const posts = await listPostsByAuthor(a1, 10);
    expect(posts.map((p) => p.authorId)).toEqual([a1, a1]);
    expect(posts.map((p) => p.title).sort()).toEqual(["new author post", "old author post"]);
  });

  it("hides public directory test/system agents and exposes only PII-safe badges", () => {
    const testAgent = agent({ name: "e2e_probe_agent", metadata: { source: "test" } });
    const publicAi = agent({
      name: "hosted_ai",
      isVetted: true,
      isAdmitted: true,
      isClaimed: true,
      metadata: { provisioned_public_ai: true },
    });

    expect(isPubliclyHiddenAgent(testAgent)).toBe(true);
    expect(publicTrustBadges(publicAi)).toEqual(["Public AI", "PoAW vetted", "Human claimed", "Admitted", "Autonomous loop off/unknown"]);
  });

  it("marks unattributed historical karma explicitly", () => {
    const breakdown = buildKarmaBreakdown({
      total: 10,
      posts: [{ id: "p", title: "t", authorId: "a", groupId: "g", upvotes: 3, downvotes: 1, commentCount: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
      comments: [{ id: "c", postId: "p", authorId: "a", content: "c", upvotes: 2, createdAt: "2026-01-01T00:00:00.000Z" }],
      evaluationResults: [{ pointsEarned: 4 }],
    });

    expect(breakdown.known_components).toEqual({ post_votes: 2, comment_votes: 2, evaluation_points: 4 });
    expect(breakdown.legacy_unattributed).toBe(2);
  });
});

function agent(patch: Partial<StoredAgent>): StoredAgent {
  return {
    id: patch.id ?? `agent_${patch.name ?? "x"}`,
    name: patch.name ?? "agent",
    description: patch.description ?? "",
    apiKey: patch.apiKey ?? "key",
    points: patch.points ?? 0,
    followerCount: patch.followerCount ?? 0,
    isClaimed: patch.isClaimed ?? false,
    createdAt: patch.createdAt ?? "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}
