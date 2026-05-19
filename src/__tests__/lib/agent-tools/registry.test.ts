import { createAgent } from "@/lib/store/agents/memory";
import { executeTool, PLATFORM_TOOLS } from "@/lib/agent-tools";
import { LOOP_TOOL_DOMAINS, LOOP_TOOL_DENYLIST, LOOP_TERMINAL_TOOLS } from "@/lib/agent-runtime";

const platformNames = PLATFORM_TOOLS.map((tool) => tool.function.name);
const platformSet = new Set(platformNames);
const routedNames = new Set(Object.values(LOOP_TOOL_DOMAINS).flat());

describe("agent tool registry", () => {
  it("aggregates the split tool definitions", () => {
    expect(platformNames).toContain("create_post");
    expect(platformNames).toContain("recall_memory");
    expect(platformNames).not.toContain("list_houses");
    expect(platformSet.size).toBe(platformNames.length);
    expect(PLATFORM_TOOLS.length).toBeGreaterThanOrEqual(60);
    expect(PLATFORM_TOOLS.length).toBeLessThanOrEqual(70);
  });

  it("routes every platform tool into a domain or the denylist", () => {
    const unrouted = platformNames.filter(
      (name) => !routedNames.has(name) && !LOOP_TOOL_DENYLIST.has(name)
    );
    expect(unrouted).toEqual([]);
  });

  it("never routes a tool that is not a real platform tool", () => {
    const ghosts = [...routedNames].filter((name) => !platformSet.has(name));
    expect(ghosts).toEqual([]);
  });

  it("identifies every terminal tool and keeps it routed and real", () => {
    expect(LOOP_TERMINAL_TOOLS.size).toBeGreaterThan(0);
    for (const name of LOOP_TERMINAL_TOOLS) {
      expect(platformSet.has(name)).toBe(true);
      expect(routedNames.has(name)).toBe(true);
    }
  });

  it("classifies known mutating tools as terminal and known read tools as non-terminal", () => {
    for (const name of ["create_post", "create_comment", "join_group", "follow_agent", "submit_playground_action"]) {
      expect(LOOP_TERMINAL_TOOLS.has(name)).toBe(true);
    }
    for (const name of ["list_feed", "list_groups", "get_my_profile", "recall_memory", "list_classes"]) {
      expect(LOOP_TERMINAL_TOOLS.has(name)).toBe(false);
    }
  });

  it("returns a structured error for unknown tools", async () => {
    const agent = await createAgent(`registry-${Date.now()}`, "registry test");
    await expect(executeTool("unknown_tool", {}, agent)).resolves.toEqual({
      success: false,
      error: "Unknown tool: unknown_tool",
    });
  });
});
