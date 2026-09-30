/**
 * M11b lane M (P6.4, codex round 1 F4) — `countActiveNowFollowees`, exercised for real (not
 * mocked, unlike `sections.test.ts`): a hidden followee must not move the count, and the cutoff
 * must be strict, matching `presenceBucket`'s own `age < threshold` boundary.
 *
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

import { countActiveNowFollowees } from "@/lib/store";
import { ACTIVE_NOW_THRESHOLD_MS } from "@/lib/agent-public";
import type { StoredAgent } from "@/lib/store-types";

let seq = 0;
const nextId = (label: string) => `${label}${Date.now().toString(36)}${(seq += 1)}`;

function makeAgent(label: string, overrides: Partial<StoredAgent> = {}): StoredAgent {
  const id = nextId(label);
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
    ...overrides,
  };
}

async function freshStores() {
  const memory = await import("@/lib/store/_memory-state");
  memory.agents.clear();
  memory.following.clear();
  return memory;
}

async function seedFollow(follower: StoredAgent, followee: StoredAgent): Promise<void> {
  const { agents, following } = await import("@/lib/store/_memory-state");
  agents.set(follower.id, follower);
  agents.set(followee.id, followee);
  const set = following.get(follower.id) ?? new Set<string>();
  set.add(followee.id);
  following.set(follower.id, set);
}

describe("countActiveNowFollowees", () => {
  it("excludes a publicly hidden followee, even though it is active", async () => {
    await freshStores();
    const follower = makeAgent("follower");
    const visible = makeAgent("visible", { lastActiveAt: new Date().toISOString() });
    const hidden = makeAgent("hidden", {
      lastActiveAt: new Date().toISOString(),
      metadata: { system: true },
    });
    await seedFollow(follower, visible);
    await seedFollow(follower, hidden);

    expect(await countActiveNowFollowees(follower.id, ACTIVE_NOW_THRESHOLD_MS)).toBe(1);
  });

  /**
   * Mutation-check anchor: a `>=` cutoff (the pre-fix behavior) counts an agent at EXACTLY the
   * threshold; `presenceBucket` buckets that same instant as `today`. Flipping `>` back to `>=`
   * here reproduces the finding — this assertion is what catches it.
   */
  it("excludes a followee whose last activity is exactly at the threshold", async () => {
    await freshStores();
    const follower = makeAgent("follower");
    const atCutoff = makeAgent("at-cutoff", {
      lastActiveAt: new Date(Date.now() - ACTIVE_NOW_THRESHOLD_MS).toISOString(),
    });
    const justInside = makeAgent("inside", {
      lastActiveAt: new Date(Date.now() - (ACTIVE_NOW_THRESHOLD_MS - 1000)).toISOString(),
    });
    await seedFollow(follower, atCutoff);
    await seedFollow(follower, justInside);

    expect(await countActiveNowFollowees(follower.id, ACTIVE_NOW_THRESHOLD_MS)).toBe(1);
  });
});
