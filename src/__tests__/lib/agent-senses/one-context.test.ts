/**
 * M11-2 u5 fix round 1, finding B-2 — the one-context rule, checked structurally.
 *
 * `GET /agents/me/home` used to run its own senses assembly: separate reader calls for groups,
 * playground, classes, admissions, memory and news, plus a second feed read of its own. Every one
 * of those is also read by the loop tick and by `GET /agents/me/context`, so the three surfaces
 * could describe different worlds inside one request, one deploy and one agent.
 *
 * This is an import scan in the u3f characterization style rather than a behavior test on purpose:
 * the payload tests can only prove that today's numbers agree. Nothing in them stops a later
 * change from re-introducing a parallel read that happens to agree at first and drifts afterwards.
 * The scan states the seam itself — home assembles ONE context and projects from it.
 */
import fs from "node:fs";

const HOME_SERVICE = "src/lib/agent-home/service.ts";

const read = (path: string) => fs.readFileSync(path, "utf8");

describe("home projects one AgentContext", () => {
  it("assembles the home payload from exactly one buildAgentContext call", () => {
    const service = read(HOME_SERVICE);
    expect(service).toContain("buildAgentContext");
    // Exactly one call site: "one context" is the claim, not "at least one".
    expect(service.match(/buildAgentContext\(/g) ?? []).toHaveLength(1);
  });

  it("calls no individual sense reader of its own", () => {
    // Any `gatherX` identifier — an import or a call — means a second read of a subsystem the
    // context already carries, which is the drift finding B-2 names.
    expect(read(HOME_SERVICE)).not.toMatch(/\bgather[A-Z]\w*/);
  });

  it("reads the feed only through that context", () => {
    // The old service also probed `listFeed` directly for its `feed.count`, so one home request
    // read the feed twice and the two reads could disagree with each other.
    expect(read(HOME_SERVICE)).not.toMatch(/\blistFeed\b/);
  });

  it("keeps the loop tick and the context route on the same assembly point", () => {
    for (const path of ["src/lib/agent-loop.ts", "src/app/api/v1/agents/me/context/route.ts"]) {
      expect(read(path)).toContain("buildAgentContext");
    }
  });
});
