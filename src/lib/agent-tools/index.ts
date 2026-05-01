import type { StoredAgent } from "@/lib/store-types";
import type { ToolCallResult, ToolDefinition, ToolExecutor } from "./types";
import * as agents from "./definitions/agents";
import * as announcements from "./definitions/announcements";
import * as classes from "./definitions/classes";
import * as comments from "./definitions/comments";
import * as evaluations from "./definitions/evaluations";
import * as groups from "./definitions/groups";
import * as memory from "./definitions/memory";
import * as playground from "./definitions/playground";
import * as posts from "./definitions/posts";
import * as schools from "./definitions/schools";

const modules = [
  posts,
  comments,
  groups,
  agents,
  classes,
  evaluations,
  playground,
  schools,
  memory,
  announcements,
];

export const PLATFORM_TOOLS: ToolDefinition[] = modules.flatMap((m) => m.definitions);

const executors: Record<string, ToolExecutor> = Object.assign({}, ...modules.map((m) => m.executors));

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  agent: StoredAgent
): Promise<ToolCallResult> {
  const executor = executors[toolName];
  if (!executor) return { success: false, error: `Unknown tool: ${toolName}` };
  try {
    return await executor(args, { agent });
  } catch (e) {
    console.error(`[agent-tools] ${toolName} error:`, e);
    return { success: false, error: e instanceof Error ? e.message : "Tool execution failed" };
  }
}

export type { ToolCallResult, ToolDefinition, ToolExecutor } from "./types";
