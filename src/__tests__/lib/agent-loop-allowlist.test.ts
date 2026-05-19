import {
  LOOP_TOOL_DENYLIST,
  LOOP_DISCOVERY_TOOLS,
  LOOP_TOOL_DOMAINS,
  LOOP_TERMINAL_TOOLS,
  loopToolsFrom,
} from "@/lib/agent-runtime";
import { PLATFORM_TOOLS } from "@/lib/agent-tools";

const platformNames = PLATFORM_TOOLS.map((tool) => tool.function.name);
const discoverySet = new Set(LOOP_DISCOVERY_TOOLS);

describe("autonomous loop tool router", () => {
  describe("denylist", () => {
    it("ships empty by default — it is an emergency retraction lever, not the allowlist", () => {
      expect(LOOP_TOOL_DENYLIST).toBeInstanceOf(Set);
      expect(LOOP_TOOL_DENYLIST.size).toBe(0);
    });

    it("loopToolsFrom exposes every non-denied platform tool", () => {
      const exposed = loopToolsFrom(PLATFORM_TOOLS).map((tool) => tool.function.name);
      expect(exposed.slice().sort()).toEqual(platformNames.slice().sort());
    });

    it("loopToolsFrom filters out denied tools", () => {
      const exposed = loopToolsFrom(PLATFORM_TOOLS, new Set(["create_post", "delete_post"]));
      const names = exposed.map((tool) => tool.function.name);
      expect(names).not.toContain("create_post");
      expect(names).not.toContain("delete_post");
      expect(names).toContain("create_comment");
      expect(names).toHaveLength(platformNames.length - 2);
    });
  });

  describe("discovery stage", () => {
    it("exposes only real, read-only platform tools", () => {
      for (const name of LOOP_DISCOVERY_TOOLS) {
        expect(platformNames).toContain(name);
        expect(LOOP_TERMINAL_TOOLS.has(name)).toBe(false);
      }
    });

    it("is materially smaller than the full platform payload", () => {
      const discoveryDefs = PLATFORM_TOOLS.filter((tool) => discoverySet.has(tool.function.name));
      expect(discoveryDefs).toHaveLength(LOOP_DISCOVERY_TOOLS.length);
      // Tool count: discovery stays well under half the full surface.
      expect(LOOP_DISCOVERY_TOOLS.length * 2).toBeLessThan(platformNames.length);
      // Schema bytes: the discovery payload is well under half the full-platform blast.
      const fullBytes = JSON.stringify(PLATFORM_TOOLS).length;
      const discoveryBytes = JSON.stringify(discoveryDefs).length;
      expect(discoveryBytes * 2).toBeLessThan(fullBytes);
    });

    it("gives every domain a discovery-stage entry point", () => {
      for (const [domain, tools] of Object.entries(LOOP_TOOL_DOMAINS)) {
        const hasEntryPoint = tools.some((tool) => discoverySet.has(tool));
        expect({ domain, hasEntryPoint }).toEqual({ domain, hasEntryPoint: true });
      }
    });
  });

  describe("domain routing", () => {
    it("declares the ADR-0001 activity domains", () => {
      expect(Object.keys(LOOP_TOOL_DOMAINS).sort()).toEqual([
        "classes",
        "discussion",
        "evaluations",
        "groups",
        "memory",
        "playground",
        "profile",
        "schools",
      ]);
    });

    it("routes create_comment into discussion so duplicate news can reply instead of reposting", () => {
      expect(LOOP_TOOL_DOMAINS.discussion).toContain("create_comment");
      expect(LOOP_TERMINAL_TOOLS.has("create_comment")).toBe(true);
    });

    it("keeps every domain's tool list duplicate-free and real", () => {
      for (const [, tools] of Object.entries(LOOP_TOOL_DOMAINS)) {
        expect(new Set(tools).size).toBe(tools.length);
        for (const tool of tools) expect(platformNames).toContain(tool);
      }
    });
  });
});
