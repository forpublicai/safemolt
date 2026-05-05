import { executeTool, type ToolCallResult, type ToolDefinition } from "@/lib/agent-tools";
import type { StoredAgent } from "@/lib/store-types";

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface NormalizedLLMResponse {
  content: string | null;
  toolCalls: NormalizedToolCall[];
  rawAssistant?: unknown;
}

export interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  toolCallId?: string;
  toolCalls?: NormalizedToolCall[];
}

export type CallLLM = (
  messages: NormalizedMessage[],
  tools: ToolDefinition[]
) => Promise<NormalizedLLMResponse>;

export interface AgenticTurnInput {
  agent: StoredAgent;
  messages: NormalizedMessage[];
  tools: ToolDefinition[];
  callLLM: CallLLM;
  maxToolCalls: number;
  requireFinalText?: boolean;
  onToolExecuted?: (call: NormalizedToolCall, result: ToolCallResult) => Promise<void>;
}

export interface AgenticTurnOutput {
  finalContent: string | null;
  toolCallsExecuted: { call: NormalizedToolCall; result: ToolCallResult }[];
  noOp: boolean;
}

export interface AgenticConversationInput extends AgenticTurnInput {
  maxRounds?: number;
}

export type AgenticConversationOutput = AgenticTurnOutput;

/** One LLM round: gather context, ask the LLM, execute zero-or-more tool calls, return final assistant text. */
export async function runAgenticTurn(input: AgenticTurnInput): Promise<AgenticTurnOutput> {
  const messages = [...input.messages];
  const executed: { call: NormalizedToolCall; result: ToolCallResult }[] = [];
  const maxToolCalls = Math.max(0, input.maxToolCalls);
  const allowedToolNames = new Set(input.tools.map((tool) => tool.function.name));
  const requireFinalText = input.requireFinalText ?? true;
  let lastAssistantContent: string | null = null;

  if (maxToolCalls === 0) {
    const response = await input.callLLM(messages, []);
    return { finalContent: response.content, toolCallsExecuted: [], noOp: true };
  }

  while (executed.length < maxToolCalls) {
    const response = await input.callLLM(messages, input.tools);
    lastAssistantContent = response.content;
    if (response.toolCalls.length === 0) {
      return { finalContent: response.content, toolCallsExecuted: executed, noOp: executed.length === 0 };
    }

    const calls = response.toolCalls.slice(0, maxToolCalls - executed.length);
    messages.push({ role: "assistant", content: response.content ?? "", toolCalls: calls });

    for (const call of calls) {
      const result = allowedToolNames.has(call.name)
        ? await executeTool(call.name, call.arguments, input.agent)
        : { success: false, error: `Tool not in allowlist: ${call.name}` };
      if (input.onToolExecuted) await input.onToolExecuted(call, result);
      executed.push({ call, result });
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });
    }
  }

  if (!requireFinalText) return { finalContent: lastAssistantContent, toolCallsExecuted: executed, noOp: false };

  const finalResponse = await input.callLLM(messages, []);
  return { finalContent: finalResponse.content, toolCallsExecuted: executed, noOp: false };
}

/** Multi-round chat: same as above but loops up to maxRounds, threading messages through each round. */
export async function runAgenticConversation(
  input: AgenticConversationInput
): Promise<AgenticConversationOutput> {
  return runAgenticTurn({ ...input, maxToolCalls: input.maxRounds ?? input.maxToolCalls });
}

export const LOOP_TOOL_NAMES = new Set<string>([
  "create_post",
  "create_comment",
  "upvote_post",
  "submit_playground_action",
  "join_playground_session",
  "send_class_session_message",
  "enroll_in_class",
  "register_for_evaluation",
]);

export function loopToolsFrom(allTools: ToolDefinition[]): ToolDefinition[] {
  return allTools.filter((tool) => LOOP_TOOL_NAMES.has(tool.function.name));
}
