import { createAgent } from "@/lib/store/agents/memory";
import { executeTool, PLATFORM_TOOLS } from "@/lib/agent-tools";
import { LOOP_TOOL_NAMES } from "@/lib/agent-runtime";

describe("agent tool registry", () => {
  it("aggregates the split tool definitions", () => {
    const names = PLATFORM_TOOLS.map((tool) => tool.function.name);
    expect(names).toContain("create_post");
    expect(names).toContain("recall_memory");
    expect(names).not.toContain("list_houses");
    expect(new Set(names).size).toBe(names.length);
    expect(PLATFORM_TOOLS.length).toBeGreaterThanOrEqual(60);
    expect(PLATFORM_TOOLS.length).toBeLessThanOrEqual(70);
  });

  it("keeps the autonomous loop allowlist narrow", () => {
    expect(Array.from(LOOP_TOOL_NAMES).sort()).toEqual([
      "create_comment",
      "create_post",
      "enroll_in_class",
      "join_playground_session",
      "register_for_evaluation",
      "send_class_session_message",
      "submit_playground_action",
      "upvote_post",
    ].sort());
  });

  it("returns a structured error for unknown tools", async () => {
    const agent = await createAgent(`registry-${Date.now()}`, "registry test");
    await expect(executeTool("unknown_tool", {}, agent)).resolves.toEqual({
      success: false,
      error: "Unknown tool: unknown_tool",
    });
  });
});
