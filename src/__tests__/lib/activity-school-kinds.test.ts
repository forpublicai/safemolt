/**
 * M9 C3 (B2): the AO/school activity kinds the store ingests must render with
 * their own segments/link types and pass the trail type filter, instead of
 * falling through to the agent_loop fallback.
 */

import type { StoredActivityFeedItem } from "@/lib/store-types";

const SCHOOL_KINDS = [
  "ao_company",
  "ao_fellowship",
  "ao_demo_day",
  "ao_working_paper",
  "school_event",
] as const;

function feedItem(
  kind: StoredActivityFeedItem["kind"],
  overrides: Partial<StoredActivityFeedItem> = {}
): StoredActivityFeedItem {
  return {
    id: `${kind}-1`,
    kind,
    occurredAt: "2026-05-01T12:00:00.000Z",
    actorId: "agent-1",
    actorName: "Moiraine",
    actorCanonicalName: "moiraine",
    title: `${kind} happened`,
    href: `/external/${kind}`,
    summary: `${kind} summary`,
    contextHint: "",
    searchText: kind,
    metadata: {},
    ...overrides,
  };
}

async function loadActivityModule(items: StoredActivityFeedItem[]) {
  jest.resetModules();
  jest.doMock("@/lib/store", () => ({
    countAgents: jest.fn(async () => 1),
    listActivityFeed: jest.fn(async () => items),
    listClasses: jest.fn(async () => []),
    getAgentById: jest.fn(),
    getGroup: jest.fn(),
    getPost: jest.fn(),
    listPosts: jest.fn(),
  }));
  jest.doMock("@/lib/db", () => ({ hasDatabase: () => false }));
  jest.doMock("@/lib/evaluations/loader", () => ({ getEvaluation: () => null }));
  jest.doMock("@/lib/playground/games", () => ({ getGame: () => null }));
  jest.doMock("@/lib/utils", () => ({
    getAgentDisplayName: (agent: { name: string }) => agent.name,
  }));
  return import("@/lib/activity");
}

describe("school/AO activity kinds (M9 C3)", () => {
  it("renders every school kind with a school-typed link, not as agent_loop", async () => {
    const { getActivityTrailPage } = await loadActivityModule(
      SCHOOL_KINDS.map((kind) => feedItem(kind))
    );
    const { activities } = await getActivityTrailPage({ limit: 20 });

    expect(activities).toHaveLength(SCHOOL_KINDS.length);
    for (const kind of SCHOOL_KINDS) {
      const activity = activities.find((a) => a.kind === kind);
      expect(activity).toBeDefined();
      const links = activity!.segments.filter((s) => s.type === "link");
      expect(links.map((l) => (l.type === "link" ? l.linkType : null))).toContain("school");
      const schoolLink = links.find((l) => l.type === "link" && l.linkType === "school");
      expect(schoolLink && schoolLink.type === "link" ? schoolLink.href : null).toBe(
        `/external/${kind}`
      );
    }
  });

  it("renders an actor-less school event as plain titled text", async () => {
    const { getActivityTrailPage } = await loadActivityModule([
      feedItem("school_event", {
        actorId: undefined,
        actorName: undefined,
        actorCanonicalName: undefined,
        href: undefined,
      }),
    ]);
    const { activities } = await getActivityTrailPage({ limit: 5 });

    expect(activities).toHaveLength(1);
    expect(activities[0].kind).toBe("school_event");
    expect(activities[0].segments).toEqual([
      { type: "text", text: "school_event happened" },
    ]);
  });

  it("passes the school/ao type filters and is excluded by others", async () => {
    const items = [
      ...SCHOOL_KINDS.map((kind) => feedItem(kind)),
      feedItem("post", { id: "post-1" }),
    ];

    for (const filter of ["school", "ao"]) {
      const { getActivityTrailPage } = await loadActivityModule(items);
      const { activities } = await getActivityTrailPage({ types: [filter], limit: 20 });
      expect(new Set(activities.map((a) => a.kind))).toEqual(new Set(SCHOOL_KINDS));
    }

    const { getActivityTrailPage } = await loadActivityModule(items);
    const { activities } = await getActivityTrailPage({ types: ["post"], limit: 20 });
    expect(activities.map((a) => a.kind)).toEqual(["post"]);
  });

  it("renders follow and group_join with their own segments and filters", async () => {
    const items = [
      feedItem("follow", {
        title: "Moiraine followed lan",
        metadata: { followee_id: "agent-2", followee_name: "lan" },
        href: "/u/lan",
      }),
      feedItem("group_join", {
        title: "Moiraine joined g/general",
        metadata: { group_id: "general", group_name: "general" },
        href: "/g/general",
      }),
    ];
    const { getActivityTrailPage } = await loadActivityModule(items);
    const { activities } = await getActivityTrailPage({ limit: 10 });

    const follow = activities.find((a) => a.kind === "follow");
    expect(follow).toBeDefined();
    expect(follow!.segments).toContainEqual({
      type: "link",
      text: "lan",
      href: "/u/lan",
      linkType: "agent",
    });

    const groupJoin = activities.find((a) => a.kind === "group_join");
    expect(groupJoin).toBeDefined();
    expect(groupJoin!.segments).toContainEqual({
      type: "link",
      text: "g/general",
      href: "/g/general",
      linkType: "group",
    });

    const { getActivityTrailPage: reload } = await loadActivityModule(items);
    const { activities: followsOnly } = await reload({ types: ["follows"], limit: 10 });
    expect(followsOnly.map((a) => a.kind)).toEqual(["follow"]);
  });
});
