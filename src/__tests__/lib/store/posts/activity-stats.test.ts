/**
 * Home page post totals are counted in storage, not summed from a fetched page. The home stats
 * used to sum a `listPosts({ limit: 100 })` page, so "posts" stopped at 100 however many existed.
 *
 * @jest-environment node
 */
import { groups, posts, resetGroupState } from "@/lib/store/_memory-state";
import { getPostActivityStats } from "@/lib/store/posts/memory";
import type { StoredGroup, StoredPost } from "@/lib/store-types";

const HOUR = 60 * 60 * 1000;

function group(id: string, schoolId?: string): StoredGroup {
  return {
    id,
    name: id,
    displayName: id,
    description: "",
    type: "group",
    ownerId: "owner",
    memberIds: [],
    moderatorIds: [],
    pinnedPostIds: [],
    schoolId,
    createdAt: new Date(0).toISOString(),
  };
}

function post(id: string, groupId: string, ageMs: number, commentCount: number, deleted = false): StoredPost {
  return {
    id,
    title: id,
    authorId: "author",
    groupId,
    upvotes: 0,
    downvotes: 0,
    commentCount,
    createdAt: new Date(Date.now() - ageMs).toISOString(),
    ...(deleted ? { deletedAt: new Date().toISOString() } : {}),
  };
}

beforeEach(() => {
  posts.clear();
  resetGroupState();
  groups.set("g_foundation", group("g_foundation"));
  groups.set("g_ao", group("g_ao", "ao"));
});

afterAll(() => {
  posts.clear();
  resetGroupState();
});

describe("getPostActivityStats (memory)", () => {
  it("counts every live post, not a capped page", async () => {
    for (let i = 0; i < 130; i++) posts.set(`p${i}`, post(`p${i}`, "g_foundation", 2 * HOUR, 1));

    await expect(getPostActivityStats("foundation")).resolves.toEqual({
      posts: 130,
      comments: 130,
      postsLastHour: 0,
    });
  });

  it("scopes to the school, skips deleted posts, and counts the last hour", async () => {
    posts.set("recent", post("recent", "g_foundation", 10 * 60 * 1000, 3));
    posts.set("old", post("old", "g_foundation", 3 * HOUR, 4));
    posts.set("deleted", post("deleted", "g_foundation", 60 * 1000, 5, true));
    posts.set("other_school", post("other_school", "g_ao", 60 * 1000, 6));

    await expect(getPostActivityStats("foundation")).resolves.toEqual({
      posts: 2,
      comments: 7,
      postsLastHour: 1,
    });
    await expect(getPostActivityStats("ao")).resolves.toEqual({
      posts: 1,
      comments: 6,
      postsLastHour: 1,
    });
  });
});
