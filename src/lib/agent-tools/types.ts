import type { StoredAgent } from "@/lib/store-types";

export interface ToolDefinition {
  type: "function";
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
