/**
 * M11b lane M (P6.4, codex round 2 F1) — `listAgents(sort, "active_now")` must apply the presence
 * predicate BEFORE any row cap, not filter an already-truncated list. The db twin's bug was a
 * `LIMIT 500` ahead of the filter; this exercises the memory twin's matching predicate order,
 * which the fix keeps identical on both sides.
 *
 * @jest-environment node
 */
jest.mock("@/lib/db", () => ({ hasDatabase: () => false, sql: null }));

import { listAgents } from "@/lib/store";
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

async function freshStore() {
  const memory = await import("@/lib/store/_memory-state");
  memory.agents.clear();
  return memory;
}

describe("listAgents(sort, \"active_now\")", () => {
  it("returns an active agent even behind more than 500 dormant ones", async () => {
    const { agents } = await freshStore();
    const dormant = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString();
    for (let i = 0; i < 501; i++) {
      const a = makeAgent(`dormant${i}`, { lastActiveAt: dormant, createdAt: new Date(Date.now() + i).toISOString() });
      agents.set(a.id, a);
    }
    const active = makeAgent("active", { lastActiveAt: new Date().toISOString() });
    agents.set(active.id, active);

    const result = await listAgents("recent", "active_now");

    expect(result.map((a) => a.id)).toEqual([active.id]);
  });

  it("excludes an agent exactly at the threshold, matching presenceBucket's own boundary", async () => {
    const { agents } = await freshStore();
    const atCutoff = makeAgent("at-cutoff", {
      lastActiveAt: new Date(Date.now() - ACTIVE_NOW_THRESHOLD_MS).toISOString(),
    });
    const justInside = makeAgent("inside", {
      lastActiveAt: new Date(Date.now() - (ACTIVE_NOW_THRESHOLD_MS - 1000)).toISOString(),
    });
    agents.set(atCutoff.id, atCutoff);
    agents.set(justInside.id, justInside);

    const result = await listAgents("recent", "active_now");

    expect(result.map((a) => a.id)).toEqual([justInside.id]);
  });

  it("codex round 3 F1: excludes a hidden active agent behind a small limit", async () => {
    const { agents } = await freshStore();
    const hidden = makeAgent("hidden", {
      lastActiveAt: new Date().toISOString(),
      metadata: { test: true },
    });
    const visible = makeAgent("visible", { lastActiveAt: new Date(Date.now() - 1000).toISOString() });
    agents.set(hidden.id, hidden);
    agents.set(visible.id, visible);

    const result = await listAgents("recent", "active_now", 1);

    expect(result.map((a) => a.id)).toEqual([visible.id]);
  });

  it("with no filter, returns everything (unchanged default behavior)", async () => {
    const { agents } = await freshStore();
    const a = makeAgent("a");
    const b = makeAgent("b");
    agents.set(a.id, a);
    agents.set(b.id, b);

    const result = await listAgents("recent");

    expect(result.map((x) => x.id).sort()).toEqual([a.id, b.id].sort());
  });
});
