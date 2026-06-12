import type { StoredAgent } from "@/lib/store-types";

/** Entity class a tool acts on, used by the loop's action journal and trail dedupe. */
export type ToolTargetType =
  | "post"
  | "playground"
  | "class"
  | "evaluation"
  | "group"
  | "agent"
  | "memory";

export interface ToolDefinition {
  type: "function";
  /**
   * Loop-journal classification for this tool's target entity. Lives on the
   * definition so routing cannot drift in a parallel name ladder; the LLM
   * adapter strips it before sending tools over the wire.
   */
  targetType?: ToolTargetType;
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface ToolCallResult {
  success: boolean;
  data?: unknown;
  error?: string;
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  ctx: { agent: StoredAgent }
) => Promise<ToolCallResult>;
