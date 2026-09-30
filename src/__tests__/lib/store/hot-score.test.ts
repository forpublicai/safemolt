/**
 * @jest-environment node
 *
 * M11-2 P6.5 characterization: the hot-score formula's TS twin, its comparator, and the memory
 * store's `sort === "hot"` path exercising the same production code the db twin's ORDER BY mirrors.
 */
import { hotScore, hotScoreComparator } from "@/lib/store/hot-score";
import { posts } from "@/lib/store/_memory-state";
import { listPosts } from "@/lib/store/posts/memory";
import type { StoredPost } from "@/lib/store-types";

const NOW = Date.parse("2026-01-01T00:00:00.000Z");
const HOUR = 3600_000;

function hoursAgo(h: number): string {
  return new Date(NOW - h * HOUR).toISOString();
}

/** The formula, spelled out independently of `hotScore()` so a typo in either does not cancel out. */
function expectedScore(upvotes: number, downvotes: number, commentCount: number, ageHours: number): number {
  const s = upvotes - downvotes + commentCount * 0.5;
  if (s <= 0) return s;
  return s / Math.pow(Math.max(ageHours, 1) + 2, 1.5);
}

function post(id: string, upvotes: number, downvotes: number, commentCount: number, ageHours: number): StoredPost {
  return {
    id,
    title: id,
    authorId: "author",
    groupId: "group",
    upvotes,
    downvotes,
    commentCount,
    createdAt: hoursAgo(ageHours),
  };
}

describe("hotScore", () => {
  it("matches the hand-computed formula for a positive, decayed score", () => {
    // s=10, age floored at 1h -> 10 / 3^1.5
    expect(hotScore(post("p", 10, 0, 0, 1), NOW)).toBeCloseTo(1.9245009, 5);
  });

  it("floors age at 1 hour for a brand-new post", () => {
    const brandNew = post("p", 10, 0, 0, 0);
    expect(hotScore(brandNew, NOW)).toBeCloseTo(expectedScore(10, 0, 0, 1), 10);
  });

  it("does not divide a negative score by the age term", () => {
    expect(hotScore(post("old", 0, 10, 0, 500), NOW)).toBe(-10);
    expect(hotScore(post("new", 0, 1, 0, 1), NOW)).toBe(-1);
  });

  it("does not divide a zero score by the age term", () => {
    expect(hotScore(post("p", 5, 5, 0, 10), NOW)).toBe(0);
  });

  it("weights comments at 0.5 and matches the hand-computed formula", () => {
    const p = post("p", 1, 1, 4, 5); // s = 0 + 4*0.5 = 2
    expect(hotScore(p, NOW)).toBeCloseTo(expectedScore(1, 1, 4, 5), 10);
  });

  it("matches the independently-written formula across several ages", () => {
    for (const ageHours of [1, 5, 50, 200]) {
      expect(hotScore(post("p", 10, 0, 0, ageHours), NOW)).toBeCloseTo(expectedScore(10, 0, 0, ageHours), 10);
    }
  });
});

describe("hotScoreComparator semantics", () => {
  const oldNeg = post("old_neg", 0, 10, 0, 100); // s=-10
  const newNeg = post("new_neg", 0, 1, 0, 1); // s=-1
  const zero = post("zero", 5, 5, 0, 10); // s=0
  const posNew = post("pos_new", 10, 0, 0, 1); // s=10, age 1
  const posOld = post("pos_old", 10, 0, 0, 50); // s=10, age 50
  const posComments = post("pos_comments", 1, 1, 4, 5); // s=2, age 5

  it("orders old -10 below new -1 (raw score among negatives, not age)", () => {
    const sorted = [oldNeg, newNeg].sort(hotScoreComparator(NOW));
    expect(sorted.map((p) => p.id)).toEqual(["new_neg", "old_neg"]);
  });

  it("ranks every negative-score post below every zero-or-positive-score post", () => {
    const sorted = [oldNeg, newNeg, zero, posNew, posOld, posComments].sort(hotScoreComparator(NOW));
    expect(sorted.map((p) => p.id)).toEqual(["pos_new", "pos_comments", "pos_old", "zero", "new_neg", "old_neg"]);
  });
});

describe("memory store listPosts sort=hot (production code path)", () => {
  beforeEach(() => posts.clear());

  it("orders identically to hotScoreComparator, ages measured from real time", async () => {
    const ago = (h: number) => new Date(Date.now() - h * HOUR).toISOString();
    const fixtures: StoredPost[] = [
      { id: "old_neg", title: "t", authorId: "a", groupId: "g", upvotes: 0, downvotes: 10, commentCount: 0, createdAt: ago(100) },
      { id: "new_neg", title: "t", authorId: "a", groupId: "g", upvotes: 0, downvotes: 1, commentCount: 0, createdAt: ago(1) },
      { id: "zero", title: "t", authorId: "a", groupId: "g", upvotes: 5, downvotes: 5, commentCount: 0, createdAt: ago(10) },
      { id: "pos_new", title: "t", authorId: "a", groupId: "g", upvotes: 10, downvotes: 0, commentCount: 0, createdAt: ago(1) },
      { id: "pos_old", title: "t", authorId: "a", groupId: "g", upvotes: 10, downvotes: 0, commentCount: 0, createdAt: ago(50) },
    ];
    for (const p of fixtures) posts.set(p.id, p);

    const sorted = await listPosts({ sort: "hot", limit: 10 });
    expect(sorted.map((p) => p.id)).toEqual(["pos_new", "pos_old", "zero", "new_neg", "old_neg"]);
  });
});
