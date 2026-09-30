/**
 * P6.4 — `presenceBucket` boundary conditions and `publicAgentSummary`'s payload shape.
 */
import { ACTIVE_NOW_THRESHOLD_MS, presenceBucket, publicAgentSummary } from "@/lib/agent-public";
import type { StoredAgent } from "@/lib/store-types";

const NOW = Date.parse("2026-09-08T12:00:00.000Z");
const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe("presenceBucket", () => {
  it("buckets a null or undefined lastActiveAt as dormant — never authenticated", () => {
    expect(presenceBucket(null, NOW)).toBe("dormant");
    expect(presenceBucket(undefined, NOW)).toBe("dormant");
  });

  it("is active_now just under 10 minutes and today at exactly 10 minutes", () => {
    expect(presenceBucket(new Date(NOW - (10 * MIN - 1)).toISOString(), NOW)).toBe("active_now");
    expect(presenceBucket(new Date(NOW - 10 * MIN).toISOString(), NOW)).toBe("today");
  });

  it("is today just under 24 hours and this_week at exactly 24 hours", () => {
    expect(presenceBucket(new Date(NOW - (DAY - 1)).toISOString(), NOW)).toBe("today");
    expect(presenceBucket(new Date(NOW - DAY).toISOString(), NOW)).toBe("this_week");
  });

  it("is this_week just under 7 days and dormant at exactly 7 days", () => {
    expect(presenceBucket(new Date(NOW - (7 * DAY - 1)).toISOString(), NOW)).toBe("this_week");
    expect(presenceBucket(new Date(NOW - 7 * DAY).toISOString(), NOW)).toBe("dormant");
  });

  it("treats an unparsable timestamp as dormant rather than throwing", () => {
    expect(presenceBucket("not-a-date", NOW)).toBe("dormant");
  });
});

describe("publicAgentSummary", () => {
  const agent = {
    id: "agent_1",
    name: "watcher",
    displayName: "Watcher",
    lastActiveAt: new Date(NOW - MIN).toISOString(),
  } as StoredAgent;

  it("carries name, display_name and the presence bucket, and no raw timestamp", () => {
    const summary = publicAgentSummary(agent, NOW);
    expect(summary).toEqual({ name: "watcher", display_name: "Watcher", presence: "active_now" });
    expect(JSON.stringify(summary)).not.toContain(agent.lastActiveAt);
  });

  it("falls back display_name to null when absent", () => {
    const summary = publicAgentSummary({ ...agent, displayName: undefined }, NOW);
    expect(summary.display_name).toBeNull();
  });
});

describe("mutation-check anchor: ACTIVE_NOW_THRESHOLD_MS is the single source for the 10-minute cut", () => {
  it("matches the plan's remedy value", () => {
    expect(ACTIVE_NOW_THRESHOLD_MS).toBe(10 * MIN);
  });
});
