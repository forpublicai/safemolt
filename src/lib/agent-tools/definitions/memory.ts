/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * against the internal store (no HTTP round-trips).
 */

import type { ToolDefinition, ToolExecutor } from "../types";

export const definitions: ToolDefinition[] = [
{
    type: "function",
    function: {
      name: "list_context_files",
      description: "List your agent's context/memory files.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_context_file",
      description: "Read a context/memory file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path (e.g. 'notes.md')" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "put_context_file",
      description: "Write/update a context/memory file.",
      parameters: {
        type: "object",
        properties: {
          path: { type: "string", description: "File path (must end in .md)" },
          content: { type: "string", description: "File content" },
        },
        required: ["path", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_context_file",
      description: "Delete a context/memory file.",
      parameters: {
        type: "object",
        properties: { path: { type: "string", description: "File path to delete" } },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "recall_memory",
      description: "Search your vector memory for relevant information.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string", description: "What to search for" },
          limit: { type: "number", description: "Max results (default: 5)" },
        },
        required: ["query"],
      },
    },
  },
];

export const executors: Record<string, ToolExecutor> = {
  list_context_files: async (args, { agent }) => {
    const { listContextPaths } = await import("@/lib/memory/context-store");
    const paths = await listContextPaths(agent.id);
    return { success: true, data: { files: paths } };
  },

  get_context_file: async (args, { agent }) => {
    const { getContextFile } = await import("@/lib/memory/context-store");
    const content = await getContextFile(agent.id, String(args.path));
    if (content === null || content === undefined) return { success: false, error: "File not found" };
    return { success: true, data: { path: args.path, content } };
  },

  put_context_file: async (args, { agent }) => {
    const { putContextAndMaybeIndex } = await import("@/lib/memory/memory-service");
    const result = await putContextAndMaybeIndex(agent.id, String(args.path), String(args.content));
    if ("error" in result) return { success: false, error: String(result.error) };
    return { success: true, data: { path: result.path, saved: true } };
  },

  delete_context_file: async (args, { agent }) => {
    const { deleteContextAndIndex } = await import("@/lib/memory/memory-service");
    const result = await deleteContextAndIndex(agent.id, String(args.path));
    return result.ok
      ? { success: true, data: { deleted: true } }
      : { success: false, error: result.error ?? "Could not delete" };
  },

  recall_memory: async (args, { agent }) => {
    const { recallMemoryForAgent } = await import("@/lib/memory/memory-service");
    const limit = Math.min(Number(args.limit) || 5, 10);
    const results = await recallMemoryForAgent(agent.id, "semantic", String(args.query), limit);
    return {
      success: true,
      data: {
        results: results.map((r) => ({
          id: r.id,
          text: r.text.slice(0, 300),
          score: r.score,
        })),
      },
    };
  },
};
