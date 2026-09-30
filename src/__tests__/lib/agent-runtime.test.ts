import type { StoredAgent } from "@/lib/store-types";

const toolDefs = (...names: string[]) =>
  names.map((name) => ({
    type: "function" as const,
    function: { name, description: name, parameters: { type: "object" } },
  }));

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

    // M11-2 P3.3: `runAgenticTurn` now forwards a fourth `executionGuard` argument to every
    // `executeTool` call — `undefined` here, since this turn's input carried none (every caller but
    // `agent-pulse/runner.ts` omits it).
    expect(executeTool).toHaveBeenCalledWith("create_post", { title: "Hello" }, agent, undefined);
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

  describe("terminal-tool semantics (ADR-0001)", () => {
    it("stops after the first terminal tool and skips later calls in the same assistant message", async () => {
      jest.resetModules();
      const executeTool = jest.fn(async (name: string) => ({ success: true, data: { tool: name } }));
      jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

      const { runAgenticTurn } = await import("@/lib/agent-runtime");
      const agent = { id: "agent_1", name: "tester" } as StoredAgent;
      const callLLM = jest.fn().mockResolvedValueOnce({
        content: null,
        toolCalls: [
          { id: "call_read", name: "list_feed", arguments: {} },
          { id: "call_term", name: "create_post", arguments: { title: "Hi" } },
          { id: "call_extra", name: "upvote_post", arguments: { post_id: "post_1" } },
        ],
      });

      const result = await runAgenticTurn({
        agent,
        messages: [{ role: "user", content: "go" }],
        tools: toolDefs("list_feed", "create_post", "upvote_post"),
        callLLM,
        maxToolCalls: 4,
        requireFinalText: false,
        terminalToolNames: new Set(["create_post", "upvote_post"]),
      });

      expect(executeTool.mock.calls.map((c) => c[0])).toEqual(["list_feed", "create_post"]);
      expect(callLLM).toHaveBeenCalledTimes(1);
      expect(result.terminalToolExecuted?.call.id).toBe("call_term");
      expect(result.terminalToolExecuted?.call.name).toBe("create_post");
      expect(result.terminalToolExecuted?.result).toEqual({ success: true, data: { tool: "create_post" } });
      expect(result.toolCallsExecuted).toHaveLength(2);
      expect(result.noOp).toBe(false);
    });

    it("runs read-only discovery tools across rounds before a terminal tool ends the tick", async () => {
      jest.resetModules();
      const executeTool = jest.fn(async (name: string) => ({ success: true, data: { tool: name } }));
      jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

      const { runAgenticTurn } = await import("@/lib/agent-runtime");
      const agent = { id: "agent_1", name: "tester" } as StoredAgent;
      const callLLM = jest
        .fn()
        .mockResolvedValueOnce({ content: null, toolCalls: [{ id: "c1", name: "list_groups", arguments: {} }] })
        .mockResolvedValueOnce({
          content: null,
          toolCalls: [{ id: "c2", name: "join_group", arguments: { group_id: "g1" } }],
        });

      const result = await runAgenticTurn({
        agent,
        messages: [{ role: "user", content: "go" }],
        tools: toolDefs("list_groups", "join_group"),
        callLLM,
        maxToolCalls: 4,
        requireFinalText: false,
        terminalToolNames: new Set(["join_group"]),
      });

      expect(executeTool.mock.calls.map((c) => c[0])).toEqual(["list_groups", "join_group"]);
      expect(callLLM).toHaveBeenCalledTimes(2);
      expect(result.terminalToolExecuted?.call.name).toBe("join_group");
      expect(result.toolCallsExecuted).toHaveLength(2);
    });

    it("requests final text after a terminal tool when requireFinalText is true", async () => {
      jest.resetModules();
      const executeTool = jest.fn(async (name: string) => ({ success: true, data: { tool: name } }));
      jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

      const { runAgenticTurn } = await import("@/lib/agent-runtime");
      const agent = { id: "agent_1", name: "tester" } as StoredAgent;
      const callLLM = jest
        .fn()
        .mockResolvedValueOnce({
          content: null,
          toolCalls: [{ id: "c1", name: "create_post", arguments: { title: "a" } }],
        })
        .mockResolvedValueOnce({ content: "summary", toolCalls: [] });

      const result = await runAgenticTurn({
        agent,
        messages: [{ role: "user", content: "go" }],
        tools: toolDefs("create_post"),
        callLLM,
        maxToolCalls: 4,
        requireFinalText: true,
        terminalToolNames: new Set(["create_post"]),
      });

      expect(callLLM).toHaveBeenCalledTimes(2);
      expect(result.finalContent).toBe("summary");
      expect(result.terminalToolExecuted?.call.name).toBe("create_post");
      expect(result.toolCallsExecuted).toHaveLength(1);
    });

    it("without terminalToolNames executes every requested tool call (current behavior)", async () => {
      jest.resetModules();
      const executeTool = jest.fn(async (name: string) => ({ success: true, data: { tool: name } }));
      jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

      const { runAgenticTurn } = await import("@/lib/agent-runtime");
      const agent = { id: "agent_1", name: "tester" } as StoredAgent;
      const callLLM = jest
        .fn()
        .mockResolvedValueOnce({
          content: null,
          toolCalls: [
            { id: "c1", name: "create_post", arguments: { title: "a" } },
            { id: "c2", name: "upvote_post", arguments: { post_id: "p1" } },
          ],
        })
        .mockResolvedValueOnce({ content: "done", toolCalls: [] });

      const result = await runAgenticTurn({
        agent,
        messages: [{ role: "user", content: "go" }],
        tools: toolDefs("create_post", "upvote_post"),
        callLLM,
        maxToolCalls: 4,
      });

      expect(executeTool.mock.calls.map((c) => c[0])).toEqual(["create_post", "upvote_post"]);
      expect(result.terminalToolExecuted).toBeUndefined();
      expect(result.toolCallsExecuted).toHaveLength(2);
    });

    it("counts a failed terminal tool as the terminal stop and still ends the tick", async () => {
      jest.resetModules();
      const executeTool = jest.fn(async () => ({ success: false, error: "rate limited" }));
      jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

      const { runAgenticTurn } = await import("@/lib/agent-runtime");
      const agent = { id: "agent_1", name: "tester" } as StoredAgent;
      const callLLM = jest.fn().mockResolvedValueOnce({
        content: null,
        toolCalls: [
          { id: "c1", name: "create_post", arguments: { title: "a" } },
          { id: "c2", name: "create_comment", arguments: { post_id: "p1" } },
        ],
      });

      const result = await runAgenticTurn({
        agent,
        messages: [{ role: "user", content: "go" }],
        tools: toolDefs("create_post", "create_comment"),
        callLLM,
        maxToolCalls: 4,
        requireFinalText: false,
        terminalToolNames: new Set(["create_post", "create_comment"]),
      });

      expect(executeTool).toHaveBeenCalledTimes(1);
      expect(result.terminalToolExecuted?.call.name).toBe("create_post");
      expect(result.terminalToolExecuted?.result).toEqual({ success: false, error: "rate limited" });
      expect(result.toolCallsExecuted).toHaveLength(1);
    });
  });

  describe("threaded messages output (ADR-0001)", () => {
    it("returns threaded messages on a no-op with maxToolCalls=0, usable as follow-up input", async () => {
      jest.resetModules();
      const executeTool = jest.fn(async () => ({ success: true }));
      jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

      const { runAgenticTurn } = await import("@/lib/agent-runtime");
      const agent = { id: "agent_1", name: "tester" } as StoredAgent;
      const callLLM = jest.fn().mockResolvedValue({ content: "noted", toolCalls: [] });

      const first = await runAgenticTurn({
        agent,
        messages: [{ role: "user", content: "hello" }],
        tools: toolDefs("create_post"),
        callLLM,
        maxToolCalls: 0,
      });

      expect(first.noOp).toBe(true);
      expect(first.messages).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "noted" },
      ]);

      // The returned conversation is a valid input for a follow-up turn.
      const followUp = await runAgenticTurn({
        agent,
        messages: first.messages,
        tools: toolDefs("create_post"),
        callLLM,
        maxToolCalls: 0,
      });
      expect(followUp.messages).toEqual([
        { role: "user", content: "hello" },
        { role: "assistant", content: "noted" },
        { role: "assistant", content: "noted" },
      ]);
    });

    it("returns threaded messages when the LLM takes no tool calls (no-op)", async () => {
      jest.resetModules();
      const executeTool = jest.fn(async () => ({ success: true }));
      jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

      const { runAgenticTurn } = await import("@/lib/agent-runtime");
      const agent = { id: "agent_1", name: "tester" } as StoredAgent;
      const callLLM = jest.fn().mockResolvedValueOnce({ content: "nothing to do", toolCalls: [] });

      const result = await runAgenticTurn({
        agent,
        messages: [{ role: "user", content: "go" }],
        tools: toolDefs("create_post"),
        callLLM,
        maxToolCalls: 4,
      });

      expect(result.noOp).toBe(true);
      expect(result.messages).toEqual([
        { role: "user", content: "go" },
        { role: "assistant", content: "nothing to do" },
      ]);
    });

    it("threads assistant and tool messages through a normal read/tool flow", async () => {
      jest.resetModules();
      const executeTool = jest.fn(async (name: string) => ({ success: true, data: { tool: name } }));
      jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

      const { runAgenticTurn } = await import("@/lib/agent-runtime");
      const agent = { id: "agent_1", name: "tester" } as StoredAgent;
      const callLLM = jest
        .fn()
        .mockResolvedValueOnce({
          content: null,
          toolCalls: [{ id: "c1", name: "list_feed", arguments: {} }],
        })
        .mockResolvedValueOnce({ content: "done", toolCalls: [] });

      const result = await runAgenticTurn({
        agent,
        messages: [{ role: "user", content: "go" }],
        tools: toolDefs("list_feed", "create_post"),
        callLLM,
        maxToolCalls: 4,
      });

      expect(result.messages).toEqual([
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "list_feed", arguments: {} }] },
        { role: "tool", toolCallId: "c1", content: JSON.stringify({ success: true, data: { tool: "list_feed" } }) },
        { role: "assistant", content: "done" },
      ]);

      // The threaded conversation can be fed straight back into a follow-up turn.
      const followUpLLM = jest.fn().mockResolvedValueOnce({ content: "ok", toolCalls: [] });
      const followUp = await runAgenticTurn({
        agent,
        messages: result.messages,
        tools: toolDefs("list_feed", "create_post"),
        callLLM: followUpLLM,
        maxToolCalls: 0,
      });
      expect(followUp.messages.slice(0, result.messages.length)).toEqual(result.messages);
      expect(followUp.messages[followUp.messages.length - 1]).toEqual({ role: "assistant", content: "ok" });
    });

    it("threads assistant, tool, and final messages through a terminal stop", async () => {
      jest.resetModules();
      const executeTool = jest.fn(async (name: string) => ({ success: true, data: { tool: name } }));
      jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

      const { runAgenticTurn } = await import("@/lib/agent-runtime");
      const agent = { id: "agent_1", name: "tester" } as StoredAgent;
      const callLLM = jest
        .fn()
        .mockResolvedValueOnce({
          content: null,
          toolCalls: [{ id: "c1", name: "create_post", arguments: { title: "a" } }],
        })
        .mockResolvedValueOnce({ content: "summary", toolCalls: [] });

      const result = await runAgenticTurn({
        agent,
        messages: [{ role: "user", content: "go" }],
        tools: toolDefs("create_post"),
        callLLM,
        maxToolCalls: 4,
        requireFinalText: true,
        terminalToolNames: new Set(["create_post"]),
      });

      expect(result.terminalToolExecuted?.call.name).toBe("create_post");
      expect(result.messages).toEqual([
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "create_post", arguments: { title: "a" } }] },
        { role: "tool", toolCallId: "c1", content: JSON.stringify({ success: true, data: { tool: "create_post" } }) },
        { role: "assistant", content: "summary" },
      ]);

      // A follow-up turn accepts the post-terminal conversation as input.
      const followUpLLM = jest.fn().mockResolvedValueOnce({ content: "ack", toolCalls: [] });
      const followUp = await runAgenticTurn({
        agent,
        messages: result.messages,
        tools: toolDefs("create_post"),
        callLLM: followUpLLM,
        maxToolCalls: 0,
      });
      expect(followUp.messages[followUp.messages.length - 1]).toEqual({ role: "assistant", content: "ack" });
    });

    it("threads assistant and tool messages through a terminal stop with requireFinalText=false", async () => {
      jest.resetModules();
      const executeTool = jest.fn(async (name: string) => ({ success: true, data: { tool: name } }));
      jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

      const { runAgenticTurn } = await import("@/lib/agent-runtime");
      const agent = { id: "agent_1", name: "tester" } as StoredAgent;
      const callLLM = jest.fn().mockResolvedValueOnce({
        content: null,
        toolCalls: [{ id: "c1", name: "create_post", arguments: { title: "a" } }],
      });

      const result = await runAgenticTurn({
        agent,
        messages: [{ role: "user", content: "go" }],
        tools: toolDefs("create_post"),
        callLLM,
        maxToolCalls: 4,
        requireFinalText: false,
        terminalToolNames: new Set(["create_post"]),
      });

      expect(callLLM).toHaveBeenCalledTimes(1);
      expect(result.messages).toEqual([
        { role: "user", content: "go" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "create_post", arguments: { title: "a" } }] },
        { role: "tool", toolCallId: "c1", content: JSON.stringify({ success: true, data: { tool: "create_post" } }) },
      ]);

      // Even ending on a tool message, the conversation is a valid follow-up input.
      const followUpLLM = jest.fn().mockResolvedValueOnce({ content: "next", toolCalls: [] });
      const followUp = await runAgenticTurn({
        agent,
        messages: result.messages,
        tools: toolDefs("create_post"),
        callLLM: followUpLLM,
        maxToolCalls: 0,
      });
      expect(followUp.messages[followUp.messages.length - 1]).toEqual({ role: "assistant", content: "next" });
    });

    it("does not treat a non-allowlisted terminal-name hallucination as the terminal action", async () => {
      jest.resetModules();
      const executeTool = jest.fn(async (name: string) => ({ success: true, data: { tool: name } }));
      jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

      const { runAgenticTurn } = await import("@/lib/agent-runtime");
      const agent = { id: "agent_1", name: "tester" } as StoredAgent;
      const callLLM = jest
        .fn()
        .mockResolvedValueOnce({
          content: null,
          toolCalls: [{ id: "bad", name: "join_group", arguments: { group_name: "x" } }],
        })
        .mockResolvedValueOnce({ content: "skip", toolCalls: [] });

      const result = await runAgenticTurn({
        agent,
        messages: [{ role: "user", content: "go" }],
        tools: toolDefs("create_comment"),
        callLLM,
        maxToolCalls: 4,
        terminalToolNames: new Set(["create_comment", "join_group"]),
      });

      expect(executeTool).not.toHaveBeenCalled();
      expect(result.terminalToolExecuted).toBeUndefined();
      expect(result.toolCallsExecuted).toHaveLength(1);
      expect(result.toolCallsExecuted[0].result).toEqual({ success: false, error: "Tool not in allowlist: join_group" });
      expect(result.finalContent).toBe("skip");
    });

    it("does not mutate the caller's input messages array", async () => {
      jest.resetModules();
      const executeTool = jest.fn(async () => ({ success: true }));
      jest.doMock("@/lib/agent-tools", () => ({ executeTool }));

      const { runAgenticTurn } = await import("@/lib/agent-runtime");
      const agent = { id: "agent_1", name: "tester" } as StoredAgent;
      const input: { role: "user"; content: string }[] = [{ role: "user", content: "go" }];
      const callLLM = jest.fn().mockResolvedValueOnce({ content: "noted", toolCalls: [] });

      const result = await runAgenticTurn({
        agent,
        messages: input,
        tools: toolDefs("create_post"),
        callLLM,
        maxToolCalls: 4,
      });

      expect(input).toEqual([{ role: "user", content: "go" }]);
      expect(result.messages).not.toBe(input);
    });
  });
});
