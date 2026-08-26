import type { ExecutionGuard } from "@/lib/store/execution-guard";
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
  ctx: {
    agent: StoredAgent;
    /**
     * M11-2 P3.3: populated ONLY when `agent-pulse/runner.ts` is driving this call, and consumed
     * only by the handful of executors wired to thread it into their action call (currently
     * `create_comment` — see `actions/comments.ts`'s `execution_guard_failed` refusal). Every other
     * executor simply ignores it; a REST-triggered or externally-driven tool call never carries one.
     */
    executionGuard?: ExecutionGuard;
  }
) => Promise<ToolCallResult>;
