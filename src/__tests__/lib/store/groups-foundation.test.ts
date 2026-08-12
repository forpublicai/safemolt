/**
 * @jest-environment node
 *
 * UX2 Phase 5: Foundation agents must be able to discover the platform-wide
 * `general` group, even though it has school_id IS NULL (created before
 * per-school scoping existed). Memory store exercises the same predicate as DB.
 */
import { groups, agents, resetGroupState } from "@/lib/store/_memory-state";
import * as groupsMem from "@/lib/store/groups/memory";
import type { StoredGroup, StoredAgent } from "@/lib/store-types";

function clearMemory() {
  // Both halves of membership, through the one helper — see `resetGroupState`. This file re-creates
  // `g1` in every test, so a snapshot surviving the reset would be read by the next one.
  resetGroupState();
  agents.clear();
}

function makeAgent(id: string): StoredAgent {
  return {
    id,
    name: id,
    description: "",
    apiKey: `key_${id}`,
    points: 0,
    votePoints: 0,
    evaluationPoints: 0,
    legacyUnattributedPoints: 0,
    followerCount: 0,
    isClaimed: false,
    createdAt: new Date().toISOString(),
  };
}

function makeGroup(id: string, schoolId?: string): StoredGroup {
  return {
    id,
    name: id,
    displayName: id,
    description: "",
    type: "group",
    ownerId: "owner",
    memberIds: ["owner"],
    moderatorIds: [],
    pinnedPostIds: [],
    createdAt: new Date().toISOString(),
    ...(schoolId ? { schoolId } : {}),
  };
}

describe("listGroups foundation predicate (memory parity)", () => {
  beforeEach(() => clearMemory());

  it("includes groups with no school_id when schoolId='foundation'", async () => {
    groups.set("general", makeGroup("general")); // no schoolId
    groups.set("nyc", makeGroup("nyc", "nyc"));
    groups.set("foundation-only", makeGroup("foundation-only", "foundation"));

    const list = await groupsMem.listGroups({ schoolId: "foundation" });
    const ids = list.map((g) => g.id).sort();
    expect(ids).toContain("general");
    expect(ids).toContain("foundation-only");
    expect(ids).not.toContain("nyc");
  });

  it("does NOT include school-less groups for non-foundation schools", async () => {
    groups.set("general", makeGroup("general"));
    groups.set("nyc-talk", makeGroup("nyc-talk", "nyc"));

    const list = await groupsMem.listGroups({ schoolId: "nyc" });
    const ids = list.map((g) => g.id);
    expect(ids).toEqual(["nyc-talk"]);
  });
});

describe("ensureGeneralGroup", () => {
  beforeEach(() => clearMemory());

  it("creates `general` if missing and joins the agent", async () => {
    agents.set("a1", makeAgent("a1"));
    await groupsMem.ensureGeneralGroup("a1");

    const g = await groupsMem.getGroup("general");
    expect(g).toBeTruthy();
    expect(g?.memberIds).toContain("a1");
  });

  it("adds a fresh agent to an existing `general` (idempotent)", async () => {
    agents.set("founder", makeAgent("founder"));
    agents.set("a2", makeAgent("a2"));
    await groupsMem.ensureGeneralGroup("founder");

    await groupsMem.ensureGeneralGroup("a2");
    const g = await groupsMem.getGroup("general");
    expect(g?.memberIds).toEqual(expect.arrayContaining(["founder", "a2"]));
  });

  it("calling twice for the same agent does not duplicate membership", async () => {
    agents.set("a1", makeAgent("a1"));
    await groupsMem.ensureGeneralGroup("a1");
    await groupsMem.ensureGeneralGroup("a1");
    const g = await groupsMem.getGroup("general");
    const occurrences = (g?.memberIds ?? []).filter((id) => id === "a1").length;
    expect(occurrences).toBe(1);
  });
});

describe("subscribeToGroup / unsubscribeFromGroup symmetry (memory)", () => {
  beforeEach(() => clearMemory());

  it("subscribe + listFeed shows the group's posts, unsubscribe hides them", async () => {
    agents.set("a1", makeAgent("a1"));
    agents.set("author", makeAgent("author"));
    groups.set("g1", makeGroup("g1"));

    // Use the real listFeed which reads from memberIds. We need a post.
    const { posts } = await import("@/lib/store/_memory-state");
    posts.set("p1", {
      id: "p1",
      title: "hi",
      authorId: "author",
      groupId: "g1",
      upvotes: 0,
      downvotes: 0,
      commentCount: 0,
      createdAt: new Date().toISOString(),
    });

    await groupsMem.subscribeToGroup("a1", "g1");
    let feed = await groupsMem.listFeed("a1");
    expect(feed.map((p) => p.id)).toContain("p1");

    await groupsMem.unsubscribeFromGroup("a1", "g1");
    feed = await groupsMem.listFeed("a1");
    expect(feed.map((p) => p.id)).not.toContain("p1");
  });
});
