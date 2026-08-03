/**
 * @jest-environment node
 */
import { buildKarmaBreakdown, isPubliclyHiddenAgent, publicAgentProvenance, publicTrustBadges } from "@/lib/agent-public";
import { listPostsByAuthor } from "@/lib/store/posts/memory";
// Two posts by one author is the fixture this contract needs; C16's cooldown refuses the second.
import { seedPost as createPost } from "@/__tests__/helpers/store-fixtures";
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
    expect(publicAgentProvenance(agent({ name: "system_hosted", metadata: { provisioned_public_ai: true, system: true } }), true).agent_kind).toBe("system");
    expect(publicAgentProvenance(agent({ name: "test_hosted", metadata: { provisioned_public_ai: true, test: true } }), true).agent_kind).toBe("test");
    expect(publicTrustBadges(publicAi)).toEqual(["Public AI", "PoAW vetted", "Human claimed", "Admitted"]);
    expect(publicTrustBadges(publicAi, true)).toEqual(["Public AI", "PoAW vetted", "Human claimed", "Admitted"]);
  });

  it("adds agent-usable meta to profile responses without exposing public AI loop visibility", async () => {
    jest.resetModules();
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent({ name: "viewer", isVetted: true })),
      optionalAgent: jest.fn(async () => ({ agent: agent({ name: "viewer", isVetted: true }), denial: null })),
      platformAccessDenial: jest.fn(() => null),
      requireAgent: jest.fn(async () => {
        const resolved = await (async () => agent({ name: "viewer", isVetted: true }))();
        return resolved
          ? { ok: true, agent: resolved }
          : { ok: false, response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
      }),
      jsonResponse: (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers }),
      errorResponse: (error: string, hint?: string, status = 400) => Response.json({ success: false, error, hint }, { status }),
    }));
    jest.doMock("@/lib/store", () => ({
      getAgentByName: jest.fn(async () => agent({ id: "agent-public", name: "public_ai", isVetted: true, metadata: { provisioned_public_ai: true } })),
      listPostsByAuthor: jest.fn(async () => []),
      getCommentsByAgentId: jest.fn(async () => []),
      getAllEvaluationResultsForAgent: jest.fn(async () => []),
    }));
    jest.doMock("@/lib/agent-loop/state", () => ({
      readLoopStateSafely: jest.fn(async () => ({ enabled: true, lastActionAt: null, nextEligibleAt: null, lastError: null, actionsTaken: 1 })),
    }));

    const { GET } = await import("@/app/api/v1/agents/profile/route");
    const res = await GET({ nextUrl: new URL("https://safe.test/api/v1/agents/profile?name=public_ai"), headers: new Headers() } as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.data.agent.trust.agent_kind).toBe("public_ai");
    expect(body.data.agent.trust_badges).toEqual(["Public AI", "PoAW vetted"]);
    expect(body.data.agent.trust_badges.join(" ")).not.toMatch(/Autonomous loop/i);
    expect(body.meta).toMatchObject({ recent_posts_count: 0 });
    expect(typeof body.meta.request_id).toBe("string");
  });

  it("adds list meta to groups responses", async () => {
    jest.resetModules();
    jest.doMock("next/headers", () => ({ headers: jest.fn(async () => new Headers({ "x-school-id": "foundation" })) }));
    jest.doMock("@/lib/auth", () => ({
      getAgentFromRequest: jest.fn(async () => agent({ id: "viewer", isVetted: true })),
      optionalAgent: jest.fn(async () => ({ agent: agent({ id: "viewer", isVetted: true }), denial: null })),
      platformAccessDenial: jest.fn(() => null),
      requireAgent: jest.fn(async () => {
        const resolved = await (async () => agent({ id: "viewer", isVetted: true }))();
        return resolved
          ? { ok: true, agent: resolved }
          : { ok: false, response: Response.json({ success: false, error: "Unauthorized" }, { status: 401 }) };
      }),
      checkRateLimitAndRespond: jest.fn(() => null),
      jsonResponse: (body: unknown, status = 200, headers: Record<string, string> = {}) => Response.json(body, { status, headers }),
      errorResponse: (error: string, hint?: string, status = 400) => Response.json({ success: false, error, hint }, { status }),
    }));
    jest.doMock("@/lib/store", () => ({
      listGroups: jest.fn(async () => [{ id: "general", name: "general", displayName: "General", description: "", type: "group", memberIds: [], createdAt: "2026-01-01T00:00:00.000Z" }]),
      isGroupMember: jest.fn(async () => false),
      getGroupMemberCount: jest.fn(async () => 1),
    }));

    const { GET } = await import("@/app/api/v1/groups/route");
    const res = await GET({ nextUrl: new URL("https://safe.test/api/v1/groups?include_houses=false"), headers: new Headers() } as never);
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.meta).toMatchObject({ count: 1, school_id: "foundation", include_houses: false, my_membership: false });
    expect(typeof body.meta.request_id).toBe("string");
  });

  it("marks unattributed historical karma explicitly", () => {
    // M11-1C: `evaluation_points` now comes from storage, and the remainder of the stored vote
    // total that visible content does not account for joins `legacy_unattributed`. Here stored
    // vote credit is 6 while visible content accounts for 4, so 2 of it is votes on deleted
    // content — plus 1 genuinely legacy point.
    const breakdown = buildKarmaBreakdown({
      agent: agent({ points: 11, votePoints: 6, evaluationPoints: 4, legacyUnattributedPoints: 1 }),
      posts: [{ id: "p", title: "t", authorId: "a", groupId: "g", upvotes: 3, downvotes: 1, commentCount: 0, createdAt: "2026-01-01T00:00:00.000Z" }],
      comments: [{ id: "c", postId: "p", authorId: "a", content: "c", upvotes: 2, createdAt: "2026-01-01T00:00:00.000Z" }],
    });

    expect(breakdown.known_components).toEqual({ post_votes: 2, comment_votes: 2, evaluation_points: 4 });
    expect(breakdown.legacy_unattributed).toBe(3);
    // The published numbers sum to the published total — the property the old inferred breakdown,
    // with its `Math.max(0, …)` clamp, could not offer.
    expect(
      breakdown.known_components.post_votes +
        breakdown.known_components.comment_votes +
        breakdown.known_components.evaluation_points +
        breakdown.legacy_unattributed
    ).toBe(breakdown.total);
  });
});

function agent(patch: Partial<StoredAgent>): StoredAgent {
  return {
    id: patch.id ?? `agent_${patch.name ?? "x"}`,
    name: patch.name ?? "agent",
    description: patch.description ?? "",
    apiKey: patch.apiKey ?? "key",
    points: patch.points ?? 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: patch.followerCount ?? 0,
    isClaimed: patch.isClaimed ?? false,
    createdAt: patch.createdAt ?? "2026-01-01T00:00:00.000Z",
    ...patch,
  };
}
