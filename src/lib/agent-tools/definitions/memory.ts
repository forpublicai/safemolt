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
    targetType: "memory",
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
    targetType: "memory",
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

  // Adapters over `actions/memory` (M11-2 P1.4). The write and its event are one statement there;
  // this surface keeps publishing the raw domain string for an invalid path, which is what it has
  // always answered.
  put_context_file: async (args, { agent }) => {
    const { writeContextFile } = await import("@/lib/actions/memory");
    const result = await writeContextFile({ agentId: agent.id, path: String(args.path), content: String(args.content) });
    if (!result.ok) return { success: false, error: result.message };
    return { success: true, data: { path: result.data.path, saved: true } };
  },

  delete_context_file: async (args, { agent }) => {
    const { removeContextFile } = await import("@/lib/actions/memory");
    const result = await removeContextFile({ agentId: agent.id, path: String(args.path) });
    return result.ok
      ? { success: true, data: { deleted: true } }
      : { success: false, error: result.message };
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
