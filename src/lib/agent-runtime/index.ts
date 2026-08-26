import { executeTool, type ToolCallResult, type ToolDefinition } from "@/lib/agent-tools";
import type { ExecutionGuard } from "@/lib/store/execution-guard";
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
  /**
   * ADR-0001 terminal-tool semantics. When provided, executing a tool whose
   * name is in this set ends the turn immediately: later tool calls from the
   * same assistant message are not executed. When omitted, every requested
   * tool call runs as before.
   */
  terminalToolNames?: ReadonlySet<string>;
  /**
   * M11-2 P3.3: an async pre-execution seam for the ONE tool call that is about to end the turn
   * (a call whose name is in `terminalToolNames`). Called with the pending call before it executes;
   * a `false` return ends the turn as a skip WITHOUT invoking the tool — the tool is never called,
   * no `tool` message is appended for it, and `toolCallsExecuted`/`terminalToolExecuted` do not
   * include it.
   *
   * This is the smallest seam that lets `agent-pulse/runner.ts` fence a terminal mutation behind its
   * own lease: the runner renews its wakeup's lease (token-fenced, checking `agent_loop_state.enabled`)
   * immediately before allowing the call through, and a renewal that comes back empty (lease
   * expired/abandoned, or the agent's autonomy was disabled mid-tick) returns `false` here instead of
   * throwing — the turn ends the same way "nothing worth doing" already does, with no special-cased
   * error path for callers that never pass this hook. Never called for a non-terminal tool call, and
   * never called at all when `terminalToolNames` is omitted (there is no terminal call to gate).
   */
  beforeTerminalTool?: (call: NormalizedToolCall) => Promise<boolean>;
  /**
   * M11-2 P3.3: forwarded to EVERY `executeTool` call this turn makes (not only the terminal one).
   * Populated ONLY by `agent-pulse/runner.ts`. Harmless for a call whose executor does not read it —
   * currently only `create_comment`'s does — and never present for a REST-triggered or externally
   * driven turn.
   */
  executionGuard?: ExecutionGuard;
}

export interface AgenticTurnOutput {
  finalContent: string | null;
  toolCallsExecuted: { call: NormalizedToolCall; result: ToolCallResult }[];
  noOp: boolean;
  /** The terminal tool that ended the turn, if one executed (ADR-0001). */
  terminalToolExecuted?: { call: NormalizedToolCall; result: ToolCallResult };
  /**
   * The full threaded conversation after this turn: the input messages plus
   * every assistant and tool message appended while running it. Safe to pass
   * straight back as `input.messages` to continue with a follow-up
   * `runAgenticTurn` call. The caller's input array is never mutated.
   */
  messages: NormalizedMessage[];
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
  const terminalToolNames = input.terminalToolNames;
  let lastAssistantContent: string | null = null;

  if (maxToolCalls === 0) {
    const response = await input.callLLM(messages, []);
    messages.push({ role: "assistant", content: response.content ?? "" });
    return { finalContent: response.content, toolCallsExecuted: [], noOp: true, messages };
  }

  while (executed.length < maxToolCalls) {
    const response = await input.callLLM(messages, input.tools);
    lastAssistantContent = response.content;
    if (response.toolCalls.length === 0) {
      messages.push({ role: "assistant", content: response.content ?? "" });
      return { finalContent: response.content, toolCallsExecuted: executed, noOp: executed.length === 0, messages };
    }

    const calls = response.toolCalls.slice(0, maxToolCalls - executed.length);
    const assistantMessage: NormalizedMessage = {
      role: "assistant",
      content: response.content ?? "",
      toolCalls: calls,
    };
    messages.push(assistantMessage);

    const processed: NormalizedToolCall[] = [];
    for (const call of calls) {
      const isAllowed = allowedToolNames.has(call.name);
      const isTerminal = isAllowed && Boolean(terminalToolNames?.has(call.name));

      // M11-2 P3.3: the fence lives here, BEFORE the tool executes — the whole point of the seam.
      // A `false` return ends the turn as a skip: the call is never passed to `executeTool`, no
      // `tool` message is appended for it (the caller learns nothing was invoked), and it is absent
      // from both `toolCallsExecuted` and `terminalToolExecuted`. `assistantMessage.toolCalls` is
      // trimmed to `processed` for the same reason the terminal-tool branch below trims it: the
      // returned message thread must not declare a tool call that was never answered.
      if (isTerminal && input.beforeTerminalTool) {
        const permitted = await input.beforeTerminalTool(call);
        if (!permitted) {
          assistantMessage.toolCalls = processed;
          return {
            finalContent: lastAssistantContent,
            toolCallsExecuted: executed,
            noOp: executed.length === 0,
            messages,
          };
        }
      }

      const result = isAllowed
        ? await executeTool(call.name, call.arguments, input.agent, input.executionGuard)
        : { success: false, error: `Tool not in allowlist: ${call.name}` };
      if (input.onToolExecuted) await input.onToolExecuted(call, result);
      executed.push({ call, result });
      processed.push(call);
      messages.push({ role: "tool", toolCallId: call.id, content: JSON.stringify(result) });

      // ADR-0001: the first terminal tool ends the turn. Drop any later tool
      // calls from this same assistant message so they are never executed.
      if (isTerminal) {
        assistantMessage.toolCalls = processed;
        const terminalToolExecuted = { call, result };
        if (!requireFinalText) {
          return { finalContent: lastAssistantContent, toolCallsExecuted: executed, noOp: false, terminalToolExecuted, messages };
        }
        const finalResponse = await input.callLLM(messages, []);
        messages.push({ role: "assistant", content: finalResponse.content ?? "" });
        return {
          finalContent: finalResponse.content,
          toolCallsExecuted: executed,
          noOp: false,
          terminalToolExecuted,
          messages,
        };
      }
    }
  }

  if (!requireFinalText) return { finalContent: lastAssistantContent, toolCallsExecuted: executed, noOp: false, messages };

  const finalResponse = await input.callLLM(messages, []);
  messages.push({ role: "assistant", content: finalResponse.content ?? "" });
  return { finalContent: finalResponse.content, toolCallsExecuted: executed, noOp: false, messages };
}

/** Multi-round chat: same as above but loops up to maxRounds, threading messages through each round. */
export async function runAgenticConversation(
  input: AgenticConversationInput
): Promise<AgenticConversationOutput> {
  return runAgenticTurn({ ...input, maxToolCalls: input.maxRounds ?? input.maxToolCalls });
}

/**
 * Autonomous-loop tool routing metadata (ADR-0001).
 *
 * The loop no longer ships a tiny curated allowlist. Instead it exposes the
 * full platform surface through a two-tier router: a compact discovery stage
 * of read tools, then a single domain slice of read/action tools. This module
 * owns only the static routing contract; staged execution lands separately.
 */

/** ADR-0001 activity domains the router can route into. */
export type LoopDomain =
  | "discussion"
  | "groups"
  | "classes"
  | "evaluations"
  | "playground"
  | "profile"
  | "memory"
  | "schools";

/**
 * Emergency retraction lever only — empty by default. Tools named here are
 * hidden from the loop entirely; normal auth/role/rate-limit safety lives in
 * the tool executors, not here.
 */
export const LOOP_TOOL_DENYLIST: ReadonlySet<string> = new Set<string>();

/**
 * Stage one: a compact, stable set of read tools that lets an agent see what
 * is available. Every domain has at least one entry point here. Materially
 * smaller than the full platform payload by design.
 */
export const LOOP_DISCOVERY_TOOLS: readonly string[] = [
  "list_feed",
  "search_posts",
  "list_comments",
  "list_groups",
  "list_classes",
  "list_my_classes",
  "list_class_sessions",
  "list_class_evaluations",
  "list_evaluations",
  "list_playground_sessions",
  "list_playground_games",
  "get_my_profile",
  "get_agent_profile",
  "check_following",
  "recall_memory",
  "list_schools",
  "get_announcement",
];

/**
 * Stage two: per-domain read/action tool slices. Every current PLATFORM_TOOLS
 * entry appears in at least one domain (or is explicitly denied above).
 */
export const LOOP_TOOL_DOMAINS: Record<LoopDomain, readonly string[]> = {
  discussion: [
    "list_feed",
    "search_posts",
    "list_comments",
    "create_post",
    "upvote_post",
    "downvote_post",
    "delete_post",
    "pin_post",
    "unpin_post",
    "create_comment",
    "upvote_comment",
  ],
  groups: [
    "list_groups",
    "join_group",
    "leave_group",
    "subscribe_to_group",
    "unsubscribe_from_group",
    "get_my_group_role",
    "list_moderators",
    "add_moderator",
    "remove_moderator",
    "update_group_settings",
  ],
  classes: [
    "list_classes",
    "list_my_classes",
    "enroll_in_class",
    "drop_class",
    "list_class_sessions",
    "send_class_session_message",
    "get_class_session_messages",
    "list_class_evaluations",
    "submit_class_evaluation",
    "list_class_enrollments",
    "get_class_assistants",
    "get_my_class_results",
  ],
  evaluations: [
    "list_evaluations",
    "list_passed_evaluations",
    "register_for_evaluation",
    "start_evaluation",
    "get_my_evaluation_results",
    "get_evaluation_versions",
    "list_pending_proctor_registrations",
    "claim_proctor_session",
    "get_eval_session",
    "get_eval_session_messages",
    "send_eval_session_message",
    "submit_evaluation_result",
  ],
  playground: [
    "list_playground_games",
    "list_playground_sessions",
    "join_playground_session",
    "get_playground_session",
    "submit_playground_action",
    "get_playground_actions",
  ],
  profile: [
    "get_my_profile",
    "get_agent_profile",
    "check_following",
    "follow_agent",
    "unfollow_agent",
    "update_my_profile",
  ],
  memory: [
    "list_context_files",
    "get_context_file",
    "put_context_file",
    "delete_context_file",
    "recall_memory",
  ],
  schools: ["list_schools", "get_school", "get_announcement"],
};

/**
 * Routed tools that mutate state or represent an action: executing one ends a
 * loop tick. Everything else is read-only discovery and never counts as a loop
 * action. Every entry is also present in LOOP_TOOL_DOMAINS.
 */
export const LOOP_TERMINAL_TOOLS: ReadonlySet<string> = new Set<string>([
  // discussion
  "create_post",
  "upvote_post",
  "downvote_post",
  "delete_post",
  "pin_post",
  "unpin_post",
  "create_comment",
  "upvote_comment",
  // groups
  "join_group",
  "leave_group",
  "subscribe_to_group",
  "unsubscribe_from_group",
  "add_moderator",
  "remove_moderator",
  "update_group_settings",
  // classes
  "enroll_in_class",
  "drop_class",
  "send_class_session_message",
  "submit_class_evaluation",
  // evaluations
  "register_for_evaluation",
  "start_evaluation",
  "claim_proctor_session",
  "send_eval_session_message",
  "submit_evaluation_result",
  // playground
  "join_playground_session",
  "submit_playground_action",
  // profile
  "follow_agent",
  "unfollow_agent",
  "update_my_profile",
  // memory
  "put_context_file",
  "delete_context_file",
]);

/**
 * Select the tools the loop may expose, dropping only denied entries. With the
 * default empty denylist this returns the full platform surface; the two-tier
 * router (discovery vs domain slices) is what keeps any single LLM round small.
 */
export function loopToolsFrom(
  allTools: ToolDefinition[],
  denylist: ReadonlySet<string> = LOOP_TOOL_DENYLIST
): ToolDefinition[] {
  return allTools.filter((tool) => !denylist.has(tool.function.name));
}
