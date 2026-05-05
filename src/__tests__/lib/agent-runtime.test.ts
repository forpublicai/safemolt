import type { StoredAgent } from "@/lib/store-types";

describe("agent runtime", () => {
  it("executes normalized tool calls through the shared dispatcher", async () => {
    jest.resetModules();
    const executeTool = jest.fn(async () => ({ success: true, data: { ok: true } }));
    jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

    const { runAgenticTurn } = await import("@/lib/agent-runtime");
    const agent = { id: "agent_1", name: "tester" } as StoredAgent;
    const callLLM = jest
      .fn()
      .mockResolvedValueOnce({
        content: null,
        toolCalls: [{ id: "call_1", name: "create_post", arguments: { title: "Hello" } }],
      })
      .mockResolvedValueOnce({ content: "done", toolCalls: [] });

    const result = await runAgenticTurn({
      agent,
      messages: [{ role: "user", content: "post" }],
      tools: [{
        type: "function",
        function: { name: "create_post", description: "Create a post", parameters: { type: "object" } },
      }],
      callLLM,
      maxToolCalls: 1,
    });

    expect(executeTool).toHaveBeenCalledWith("create_post", { title: "Hello" }, agent);
    expect(result.noOp).toBe(false);
    expect(result.finalContent).toBe("done");
    expect(result.toolCallsExecuted).toHaveLength(1);
  });

  it("rejects tool calls that were not included in the runtime allowlist", async () => {
    jest.resetModules();
    const executeTool = jest.fn(async () => ({ success: true }));
    jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

    const { runAgenticTurn } = await import("@/lib/agent-runtime");
    const agent = { id: "agent_1", name: "tester" } as StoredAgent;
    const result = await runAgenticTurn({
      agent,
      messages: [{ role: "user", content: "delete something" }],
      tools: [{
        type: "function",
        function: { name: "create_post", description: "Create a post", parameters: { type: "object" } },
      }],
      callLLM: async () => ({
        content: null,
        toolCalls: [{ id: "call_1", name: "delete_post", arguments: { post_id: "post_1" } }],
      }),
      maxToolCalls: 1,
      requireFinalText: false,
    });

    expect(executeTool).not.toHaveBeenCalled();
    expect(result.toolCallsExecuted).toEqual([{
      call: { id: "call_1", name: "delete_post", arguments: { post_id: "post_1" } },
      result: { success: false, error: "Tool not in allowlist: delete_post" },
    }]);
  });
});
