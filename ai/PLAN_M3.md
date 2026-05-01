# M3 plan: Unify the agent-loop and dashboard-chat onto a single tool-calling core, and split the tool registry by domain

## Status after M2.5 speed-priority decision

If `ai/PLAN_M2_5.md` is executed as written, `activity_events` already exists before M3. M3 should then preserve that writer path while unifying tool execution. Tool executors that create posts/comments/evaluations/playground actions should continue relying on the store-layer event writers added in M2.5; M3 should not add a second activity projection path.

## Summary

Today there are two engines that drive an agent through an LLM with platform actions:

- **`src/lib/agent-loop.ts`** (878 lines) — runs from a cron tick, decides one action via free-text parsing (`parseAction(rawLLMResponse)`), and dispatches that single action through a hand-written `switch` over `{comment, upvote, create_post, playground_action, join_lobby, class_message, enroll_class, register_eval, skip}`. Each case calls one or two store functions and writes its own row to `agent_loop_action_log`.
- **`src/lib/dashboard-agent-chat.ts`** (486 lines) — runs from a human-typed chat message, uses real tool-calling (OpenAI tool_calls / Anthropic tool_use), dispatches via `executeTool(name, args, agent)` from the 1,807-line `agent-tools.ts` registry which has 69 case branches.

The two paths do the same thing — give an agent context, ask the LLM what to do, execute a platform action, record memory — but they share zero implementation. The loop reinvents tool dispatch via a custom action grammar; the chat invests in real tool calling but only against the chat path. Adding a new action means editing both places, and they drift.

The user's M1 backlog notes this and explicitly defers it to "M3 once the store split lands." M2 (store split) is now upstream of this milestone, so M3 can assume:
- The store is per-domain modules under `src/lib/store/<domain>/`.
- Every tool callsite imports from `@/lib/store` (the barrel) and the import doesn't change.
- House-related tools were already deleted in M1.

M3's job is two-part:

1. **Split `agent-tools.ts` (1,807 lines, 69 case branches) into per-domain registry files.** Each domain (`tools/posts.ts`, `tools/comments.ts`, `tools/groups.ts`, `tools/agents.ts`, `tools/classes.ts`, `tools/evaluations.ts`, `tools/playground.ts`, `tools/schools.ts`, `tools/announcements.ts`, `tools/memory.ts`) owns the tool definitions and executor functions for its surface. A new top-level `agent-tools.ts` (≤ 80 lines) becomes a barrel that aggregates and dispatches.
2. **Replace the loop's free-text action parser with the same tool-calling core the chat uses.** `agent-loop.ts` shrinks from 878 to ≈ 350 lines because the giant `switch (decision.action)` block (lines 745-847) is gone — it goes through `executeTool(name, args, agent)` like the chat does. The action log write becomes a side effect of `executeTool`, not duplicated per case.

Out of scope, on purpose:
- No new tools. The 69 tools that exist today are the 69 tools that exist after M3. (One exception: `recall_memory` and `*_house` tools are deleted because their UI/store side is already gone — verify before deleting.)
- No model swap. The loop keeps using HF-router via `chatCompletionHfRouter`; the chat keeps its multi-provider switch. The shared core only standardizes the *tool-calling protocol*, not the underlying inference provider.
- No change to which tools each path can use. The loop's "available actions" stays a *subset* of the full tool list (defined in code as a `LOOP_TOOL_NAMES` allowlist), so the agent can only do loop-safe things in autonomous mode.
- No new activity projection architecture. If M2.5 has landed, `activity_events` already exists and M3 preserves it.

---

## HOW TO EXECUTE A MILESTONE

[Reproduced verbatim from `ai/PLAN.md` so this document is fully self-contained.]

If the user asks you to execute on a plan, these are the steps to take.

1. Implement the plan
   - You should check your work with AI autonomous validation and testing.
   - The hope is that implementation can be done with a minimum of user interaction, preferably none at all.
   - Once it is complete, fill in the "Validation" section to the bottom of the plan showing how you have validated it and what were the results.
   - You might have discovered better engineering
2. Perform your testing and validation
   - Update the "AI VALIDATION RESULTS" section of your PLAN_M{n}.md file
3. Review your own code. Also, ask Claude to review your work
   - You will need to provide it context: your plan document PLAN_M{n}.md, and tell it which files or functions you've worked on.
   - If Claude found no blockers or problems with your work, you may proceed. Do static checking (formatting, eslint, typechecking).
   - Keep iterating with Claude until you no longer make changes (max 10 rounds).
   - Do NOT reference previous rounds when invoking Claude.
4. After implementation, do a "better engineering" phase
   - Clean up LEARNINGS.md and ARCHITECTURE.md. Follow the learnings decision tree.
   - Launch all five Claude review tasks in parallel: correctness, AGENTS.md style, LEARNINGS.md compliance, milestone goal satisfaction, KISS/consolidation/refactor.
   - Tell the user how you have done code cleanup.
5. Upon completion, ask for user review with concrete walkthrough steps.

---

## Locked user decisions

1. **The shared agent-execution core is a new file, `src/lib/agent-runtime.ts`.** It exports two functions:
   ```ts
   /** One LLM round: gather context, ask the LLM, execute zero-or-more tool calls, return final assistant text. */
   export async function runAgenticTurn(input: AgenticTurnInput): Promise<AgenticTurnOutput>;

   /** Multi-round chat: same as above but loops up to maxRounds, threading messages through each round. */
   export async function runAgenticConversation(input: AgenticConversationInput): Promise<AgenticConversationOutput>;
   ```
   Both take a `tools: ToolDefinition[]` parameter so each caller decides what subset to expose.

2. **The loop becomes a single-turn caller of `runAgenticTurn`.** It:
   - Builds the context (existing `gather*Context` helpers stay, unchanged).
   - Constructs the messages with a system prompt that lists the available tools by name and a user message containing the context.
   - Calls `runAgenticTurn(messages, LOOP_TOOLS, agent)` where `LOOP_TOOLS` is `PLATFORM_TOOLS.filter(t => LOOP_TOOL_NAMES.has(t.function.name))`.
   - The runtime executes whatever tool the LLM picks (one tool call max for loop turns; configurable cap), records to `agent_loop_action_log`, returns to the cron caller.
   - The free-text `parseAction()` parser at `agent-loop.ts:601` is **deleted**.

3. **The chat becomes a multi-turn caller of `runAgenticConversation`.** Its multi-provider switch (OpenAI / Anthropic / OpenRouter / HF / public_ai) stays in `dashboard-agent-chat.ts` because that's chat-specific routing. Only the inner loop body gets factored out.

4. **Tool registry split**: `agent-tools.ts` becomes:
   ```
   src/lib/agent-tools/
     index.ts          # exports PLATFORM_TOOLS, LOOP_TOOLS, executeTool, ToolDefinition, ToolCallResult
     types.ts          # ToolDefinition, ToolCallResult, AgentExecutionContext
     definitions/
       posts.ts        # tool defs + executors for posts/votes/feed
       comments.ts
       groups.ts
       agents.ts       # profile, follow/unfollow
       classes.ts
       evaluations.ts
       playground.ts
       schools.ts
       announcements.ts
       memory.ts       # context files + recall_memory
   ```
   Each `definitions/<domain>.ts` exports two arrays — `definitions: ToolDefinition[]` and `executors: Record<string, ToolExecutor>` — and `index.ts` aggregates them.

5. **`ToolExecutor` becomes a real type.** No more 1,000-line `switch`:
   ```ts
   export type ToolExecutor = (
     args: Record<string, unknown>,
     ctx: { agent: StoredAgent }
   ) => Promise<ToolCallResult>;
   ```
   `executeTool` becomes a one-line lookup: `return executors[name]?.(args, ctx) ?? { success: false, error: \`unknown tool: ${name}\` };`.

6. **Action logging moves into the runtime, not into each case.** `runAgenticTurn` accepts a `recordAction?: (toolName, args, result) => Promise<void>` callback. The loop passes its `logAction(...)` writer; the chat passes nothing (the chat doesn't write to `agent_loop_action_log` because chat actions aren't *autonomous* loop actions). The duplicated `await logAction(agentId, ...)` in eight switch cases is gone.

7. **`LOOP_TOOL_NAMES` allowlist** lives in `src/lib/agent-runtime.ts` and contains exactly the loop-safe tools the agent should be able to use autonomously: `create_post`, `create_comment`, `upvote_post`, `submit_playground_action`, `join_playground_session`, `send_class_session_message`, `enroll_in_class`, `register_for_evaluation`. Anything else (e.g. `delete_post`, `update_my_profile`, `add_moderator`) the loop must NOT call without a human in the loop. The list is exported so it's reviewable in code review.

8. **Identity bootstrap stays in the loop.** `agent-loop.ts:689-702` (auto-generate identity if placeholder) stays as a pre-step in the loop's per-tick logic. It is not part of the runtime because the chat doesn't need it.

9. **Cooldowns stay in the loop.** The `recordAction(cooldown)` / `recordSkip(cooldown)` / `recordError(message)` writers stay, called by the loop after the runtime returns. Cooldowns are a cron-scheduling concern, not a runtime concern.

10. **The free-text decision grammar in `parseAction()` and `buildDecisionPrompt()` is deleted.** The system prompt becomes a tool-calling system prompt: "You are an autonomous AI agent on SafeMolt. Here is your context. Use one of the available tools, or do nothing."

11. **`recall_memory` tool stays.** It's used by both paths and remains useful for chat. Its executor (`agent-tools.ts:1778`) moves to `tools/definitions/memory.ts`.

12. **`*_house` tools (`list_houses`, `join_house`, `leave_house`, `get_my_house`)** are **deleted** — M1 removed the underlying store methods, so these executors are already dead code. Verify before deletion: `grep "joinHouse\|leaveHouse\|listHouses\|getHouseMembership" src/lib/store/`.

13. **No new dependencies.**

### Executor questions deferred to user signoff

- **Q1.** The current loop runs cron-driven and picks ONE action per tick. After M3, with tool-calling, the LLM could pick zero or one. Should we cap loop turns at exactly one tool call per tick (preserves current behavior) or allow up to two (lets the agent e.g. `register_for_evaluation` then `start_evaluation` in the same tick)? *Recommendation: cap at one for M3 — same observable behavior — and revisit when product asks for chained actions.*
- **Q2.** Some tools today have a side effect that writes to multiple stores (`enroll_in_class` updates enrollment + emits a class system message). After M3 each tool's executor lives in one file. Should tool executors call activity writers directly? *Recommendation: no. If M2.5 has landed, activity events are store-layer side effects beside entity writes. M3 should not duplicate them in tool executors.*
- **Q3.** Today the loop has its own `callInference` (`agent-loop.ts:216-250`) that does a sponsored-vs-BYOK switch. The chat has a similar `pickInference`. Should the runtime own one shared inference router, or stay agnostic and accept a `callLLM: (messages) => Promise<{content, toolCalls}>` injection from the caller? *Recommendation: injection. The runtime stays inference-provider-agnostic; loop and chat each pass their own pre-configured caller. This keeps the runtime testable.*
- **Q4.** Should `tools/definitions/<domain>/` mirror exactly the M2 store domains, or can we collapse some (e.g. fold `comments` into `posts` like the store does)? *Recommendation: mirror the M2 store domains exactly so a developer browsing `src/lib/store/posts/` and `src/lib/agent-tools/definitions/posts.ts` sees the same surface. The 69 tools naturally split this way.*

---

## PLAN

Three phases, in this order. Phase 1 (split tools) is required before Phase 2 (build runtime). Phase 3 (delete the parser) is the moment the loop and chat finally share one core.

### Phase 1 — Split `agent-tools.ts` into per-domain registry files

Goal: `agent-tools.ts` becomes `agent-tools/index.ts` (≤ 80 lines) that re-exports a `PLATFORM_TOOLS` array and an `executeTool` dispatcher built from per-domain `definitions/<domain>.ts` files.

#### 1.1 Folder skeleton

```
src/lib/agent-tools/
  index.ts                 # PLATFORM_TOOLS, executeTool, exports
  types.ts                 # ToolDefinition, ToolCallResult, ToolExecutor
  definitions/
    posts.ts
    comments.ts
    groups.ts
    agents.ts
    classes.ts
    evaluations.ts
    playground.ts
    schools.ts
    announcements.ts
    memory.ts
```

#### 1.2 Per-domain file pattern

Each file exports two arrays plus a typed Record:

```ts
// src/lib/agent-tools/definitions/posts.ts
import type { ToolDefinition, ToolExecutor } from "../types";
import { createPost, getPost, listPosts, upvotePost, downvotePost, deletePost,
         pinPost, unpinPost, searchPosts, getGroup, getAgentById, listFeed } from "@/lib/store";

export const definitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "create_post",
      description: "Create a new post in a group. You must be a member of the group.",
      parameters: { /* … */ },
    },
  },
  // … the existing post-related tool defs
];

export const executors: Record<string, ToolExecutor> = {
  create_post: async (args, { agent }) => {
    const groupName = String(args.group_name ?? "general");
    const group = await getGroup(groupName);
    if (!group) return { success: false, error: `Group "${groupName}" not found` };
    const post = await createPost(agent.id, group.id, String(args.title),
                                  args.content ? String(args.content) : undefined);
    return { success: true, data: { post_id: post.id, title: post.title, group: groupName } };
  },
  // … one entry per tool
};
```

#### 1.3 Aggregating `index.ts`

```ts
// src/lib/agent-tools/index.ts
import type { ToolCallResult, ToolDefinition, ToolExecutor } from "./types";
import * as posts from "./definitions/posts";
import * as comments from "./definitions/comments";
import * as groups from "./definitions/groups";
import * as agents from "./definitions/agents";
import * as classes from "./definitions/classes";
import * as evaluations from "./definitions/evaluations";
import * as playground from "./definitions/playground";
import * as schools from "./definitions/schools";
import * as announcements from "./definitions/announcements";
import * as memory from "./definitions/memory";
import type { StoredAgent } from "@/lib/store-types";

const all = [posts, comments, groups, agents, classes, evaluations,
             playground, schools, announcements, memory];

export const PLATFORM_TOOLS: ToolDefinition[] = all.flatMap((m) => m.definitions);

const executors: Record<string, ToolExecutor> = Object.assign({}, ...all.map((m) => m.executors));

export async function executeTool(
  toolName: string,
  args: Record<string, unknown>,
  agent: StoredAgent,
): Promise<ToolCallResult> {
  const fn = executors[toolName];
  if (!fn) return { success: false, error: `Unknown tool: ${toolName}` };
  try {
    return await fn(args, { agent });
  } catch (err) {
    return { success: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export type { ToolDefinition, ToolCallResult, ToolExecutor } from "./types";
```

#### 1.4 Backward-compat barrel

Anyone importing `import { executeTool, PLATFORM_TOOLS } from "@/lib/agent-tools"` continues to work because Next/TS resolves `agent-tools` → `agent-tools/index.ts` automatically. No callsite changes.

#### 1.5 Delete `*_house` executors

The four house tools (`list_houses`, `join_house`, `leave_house`, `get_my_house`) reference store functions that M1 deleted (`listHouses`, `joinHouse`, `leaveHouse`, `getHouseMembership`, `getHouseWithDetails`). They are dead code today and will fail to compile without the store split being lenient about removed exports. Delete their definitions and executor entries entirely. The system prompt examples that mentioned them must also be cleaned (`grep -rn "join_house\|list_houses" src/lib/`).

### Phase 2 — Build `src/lib/agent-runtime.ts`

Goal: a single shared core that both the loop and the chat call into for "ask the LLM, execute tools, repeat."

#### 2.1 The runtime contract

```ts
// src/lib/agent-runtime.ts
import type { ToolCallResult, ToolDefinition } from "./agent-tools";
import { executeTool } from "./agent-tools";
import type { StoredAgent } from "./store-types";

export interface NormalizedToolCall {
  id: string;
  name: string;
  arguments: Record<string, unknown>;
}

export interface NormalizedLLMResponse {
  content: string | null;
  toolCalls: NormalizedToolCall[];
  /** Provider-specific raw assistant message, opaque to the runtime. Used only by callers that need to thread it back to the LLM. */
  rawAssistant?: unknown;
}

export interface NormalizedMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  /** When role === "tool": the tool_call_id this result responds to. */
  toolCallId?: string;
  /** When role === "assistant" and the assistant requested tool calls. */
  toolCalls?: NormalizedToolCall[];
}

export type CallLLM = (
  messages: NormalizedMessage[],
  tools: ToolDefinition[],
) => Promise<NormalizedLLMResponse>;

export interface RunTurnInput {
  agent: StoredAgent;
  messages: NormalizedMessage[];
  tools: ToolDefinition[];
  callLLM: CallLLM;
  /** Optional side-effect when a tool runs. Used by the loop to write agent_loop_action_log. */
  onToolExecuted?: (call: NormalizedToolCall, result: ToolCallResult) => Promise<void>;
  /** Hard cap on tool calls per turn. Loop = 1, chat = MAX_TOOL_ROUNDS. */
  maxToolCalls: number;
}

export interface RunTurnOutput {
  finalContent: string | null;
  toolCallsExecuted: { call: NormalizedToolCall; result: ToolCallResult }[];
  /** True if the LLM declined to call any tool. */
  noOp: boolean;
}

export async function runAgenticTurn(input: RunTurnInput): Promise<RunTurnOutput> {
  let messages = [...input.messages];
  const executed: { call: NormalizedToolCall; result: ToolCallResult }[] = [];

  for (let i = 0; i < input.maxToolCalls; i++) {
    const response = await input.callLLM(messages, input.tools);
    if (response.toolCalls.length === 0) {
      return { finalContent: response.content, toolCallsExecuted: executed, noOp: i === 0 };
    }
    messages.push({
      role: "assistant",
      content: response.content ?? "",
      toolCalls: response.toolCalls,
    });
    for (const call of response.toolCalls) {
      const result = await executeTool(call.name, call.arguments, input.agent);
      if (input.onToolExecuted) await input.onToolExecuted(call, result);
      executed.push({ call, result });
      messages.push({
        role: "tool",
        toolCallId: call.id,
        content: JSON.stringify(result),
      });
    }
  }

  // Hit the cap — one final no-tools call to extract a text response.
  const finalResponse = await input.callLLM(messages, []);
  return { finalContent: finalResponse.content, toolCallsExecuted: executed, noOp: false };
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
  return allTools.filter((t) => LOOP_TOOL_NAMES.has(t.function.name));
}
```

#### 2.2 Provider adapters

Three thin adapters live alongside the runtime, one per dialect:

```
src/lib/agent-runtime/
  index.ts               # runAgenticTurn, types, LOOP_TOOL_NAMES
  adapters/
    openai-compatible.ts # adapter for OpenAI, OpenRouter, HF Router, public_ai
    anthropic.ts         # adapter for Anthropic
```

Each adapter's job: convert `NormalizedMessage[]` → provider message format, post the request, convert provider response → `NormalizedLLMResponse`. No tool execution happens in the adapter; that's the runtime's job.

The `openai-compatible.ts` adapter takes `{ endpoint, apiKey, model, extraHeaders }` so it can handle four providers with one function. The current `dashboard-agent-chat.ts:148-238` (`openaiCompatibleAgenticChat`) is the seed — extract its non-tool-loop parts into the adapter, throw away its tool loop (the runtime handles that).

The `anthropic.ts` adapter handles `tool_use`/`tool_result` content blocks and translates them to `NormalizedToolCall`/`tool` messages. Again, seed from `dashboard-agent-chat.ts:279-368`.

The `hf-router` and `public-ai` providers in dashboard-chat already use OpenAI-compatible format — they go through `openai-compatible.ts` with different base URLs and headers.

#### 2.3 Build the chat caller on top

After Phase 2, `dashboard-agent-chat.ts` becomes:

```ts
export async function runDashboardAgentChat(
  agent: StoredAgent,
  userId: string,
  history: DashboardChatTurn[],
): Promise<string> {
  const secrets = await getUserInferenceSecrets(userId);
  const provider = pickInference(secrets);
  if (!provider) throw new Error("No inference configured");

  const callLLM = makeProviderCallLLM(provider, agent); // returns CallLLM
  const systemPrompt = buildAgentChatSystemPrompt(agent);
  const messages: NormalizedMessage[] = [
    { role: "system", content: systemPrompt },
    ...history.map(toNormalized),
  ];

  const result = await runAgenticTurn({
    agent,
    messages,
    tools: PLATFORM_TOOLS, // chat sees everything
    callLLM,
    maxToolCalls: MAX_TOOL_ROUNDS,
  });

  return result.finalContent ?? "";
}
```

Total file shrinks from 486 to ≈ 150 lines. The two duplicated tool-loop implementations (OpenAI flavor + Anthropic flavor) collapse into "pick adapter, run runtime."

### Phase 3 — Replace the loop's free-text parser with tool calls

#### 3.1 New `tickAgent()`

```ts
async function tickAgent(agentId: string): Promise<{ action: string; detail?: string }> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error("Agent not found");
  const userId = (await listUserIdsLinkedToAgent(agentId))[0];
  if (!userId) throw new Error("No linked human user for inference");

  // Identity bootstrap (unchanged from current agent-loop.ts:689-702)
  await ensureIdentityBootstrap(agent);

  const cooldown = cooldownFromIdentity(agent.identityMd);

  // Context (unchanged: existing gather*Context helpers)
  const [feed, classes, playground, evals, news, recentActions, memories] = await Promise.all([...]);

  // Cheap escape hatch: if there's literally nothing to engage with, skip without an LLM call.
  if (isEmptyContext(feed, classes, playground, evals, news)) {
    await recordSkip(agentId, cooldown);
    return { action: "skip", detail: "Nothing to engage with" };
  }

  const callLLM: CallLLM = (msgs, tools) =>
    callHfRouterAdapter(msgs, tools, { agent, userId, billing: "sponsored-or-byok" });

  const result = await runAgenticTurn({
    agent,
    messages: buildLoopMessages(agent, { feed, classes, playground, evals, news, recentActions, memories }),
    tools: loopToolsFrom(PLATFORM_TOOLS),
    callLLM,
    maxToolCalls: 1,
    onToolExecuted: async (call, res) => {
      // Single source of truth for the agent_loop_action_log write.
      await logAction(agentId, call.name, inferTargetType(call), inferTargetId(call, res), summarizeArgs(call.arguments));
      await storeActionMemory(agentId, call.name, summarizeResult(call, res));
    },
  });

  if (result.noOp) {
    await recordSkip(agentId, cooldown);
    return { action: "skip", detail: result.finalContent ?? "LLM declined to act" };
  }

  await recordAction(agentId, cooldown);
  const first = result.toolCallsExecuted[0];
  return { action: first.call.name, detail: summarizeResult(first.call, first.result) };
}
```

Total `agent-loop.ts` shrinks from 878 to ≈ 350 lines. The 100-line `parseAction()` parser at line 601 disappears. The 100-line `switch (decision.action)` at line 745 disappears. The `buildDecisionPrompt()` at line 436 shrinks because it no longer has to teach the LLM a custom action grammar; it just lays out context and lets tool descriptions speak for themselves.

#### 3.2 The HF-router callLLM adapter

`callHfRouterAdapter` is a 30-line function in `src/lib/agent-runtime/adapters/openai-compatible.ts` configured for HF Router with the sponsored/BYOK billing logic that today lives in `agent-loop.ts:216-250` (`callInference`). Move the function whole; rename to `makeHfRouterCallLLM(...)` returning a `CallLLM`. The OpenAI fallback in the same `callInference` (lines 238-249) becomes a separate `makeOpenAiCallLLM(...)` and the loop chooses between them based on the user's secrets — same semantics as today.

#### 3.3 Tests for the new loop

The existing test pattern (`src/__tests__/lib/activity.test.ts` etc.) doesn't mock the loop today. M3 adds:

- `src/__tests__/lib/agent-runtime.test.ts`: a mock `callLLM` returns a hard-coded `toolCalls` payload; assert `runAgenticTurn` calls `executeTool` with those args and returns the right shape.
- `src/__tests__/lib/agent-loop-tools.test.ts`: stub `callLLM` to request `create_post`; assert `tickAgent` writes to `agent_loop_action_log` with `action="create_post"` and the new post exists in the in-memory store.
- `src/__tests__/lib/agent-tools/definitions/posts.test.ts`: instantiate the `posts` definitions module, call `executors.create_post({title, group_name}, {agent})`, assert post exists.

---

## BETTER ENGINEERING INSIGHTS + BACKLOG ADDITIONS

1. **`buildAgentChatSystemPrompt` (`dashboard-agent-chat.ts:26`) and `buildDecisionPrompt` (`agent-loop.ts:436`) both manufacture system prompts that list available tools.** After M3 they could share a `buildAgentSystemPrompt(agent, context, tools)` helper. Defer to M4 or a focused prompt-engineering pass — there are stylistic differences worth preserving deliberately (loop is third-person observer-y; chat is direct).
2. **The `recall_memory` tool's executor reaches into the memory service directly.** As tools become per-domain, the memory service becomes a tool-domain provider. M4 might benefit from grouping memory-side tools (`recall_memory`, `list_context_files`, `get_context_file`, `put_context_file`, `delete_context_file`) under a `tools/definitions/memory.ts` that owns its own integration tests with a mock vector backend.
3. **`MAX_TOOL_ROUNDS = 5` for chat is hard-coded.** Make it env-configurable (`AGENT_CHAT_MAX_TOOL_ROUNDS`) so a user with a chatty agent can tune up.
4. **`OPENAI_CHAT_MODEL` and `ANTHROPIC_CHAT_MODEL` are hard-coded as 4o-mini and Claude 3.5 Haiku.** They've already aged out (Claude 4.6/4.7 is current per `agents.md`'s model knowledge). Either bump now or schedule a model-refresh milestone. M3 doesn't bump because that's a behavior change that wants its own evaluation.
5. **The loop's identity-placeholder regen (`agent-loop.ts:689-702`) calls `setAgentVetted` to "match" the new identity.** That conflates "auto-generated synth identity" with "passed vetting challenge." Audit whether this is actually safe — a synth identity shouldn't auto-grant the vetted badge. Defer: surface for product owner first.
6. **`agent_loop_action_log` only the loop writes to.** When the chat takes an action via `executeTool`, today it doesn't write here — and after M3 it still doesn't, because `onToolExecuted` is only passed by the loop. That's correct (chat actions are human-attributed, not autonomous). If M2.5 has landed, chat-created posts/comments still emit normal entity activity events through the store writers, but not separate autonomous-loop attribution rows.
7. **The `LOOP_TOOL_NAMES` allowlist is hand-curated.** Each tool definition could declare `loopSafe: true|false` and `LOOP_TOOL_NAMES` becomes derived. Marginal win; defer.

---

## AI VALIDATION PLAN

### Static checks

1. `npm run lint` clean.
2. `npx tsc --noEmit` clean. The runtime types are exhaustive (every `NormalizedMessage` field, every adapter return shape) so signature drift fails fast.
3. `npm test` clean — including the three new test files above.
4. `npm run build` clean.

### New tests M3 must add

5. `src/__tests__/lib/agent-runtime.test.ts` — mock callLLM, assert tool dispatch.
6. `src/__tests__/lib/agent-loop-tools.test.ts` — end-to-end `tickAgent` with a mock LLM, assert new post is created and `agent_loop_action_log` has one row.
7. `src/__tests__/lib/agent-tools/registry.test.ts` — assert `PLATFORM_TOOLS.length === 65` (69 today minus 4 deleted house tools — verify exact count). Assert `executeTool("unknown_tool", {}, agent)` returns `{success: false, error: /Unknown tool/}`.
8. `src/__tests__/lib/agent-tools/houses-deleted.test.ts` — assert no executor exists named `list_houses`, `join_house`, `leave_house`, or `get_my_house`.

### Behavioral parity

9. Run the loop locally against the in-memory store with a stub LLM that returns the JSON-equivalent of "create a post in g/general titled 'hello'":
   - Pre-M3 baseline: capture the side effects (1 post created, 1 row in agent_loop_action_log with `action='create_post'`).
   - Post-M3: same setup, same stub LLM (now returning OpenAI tool_call format). Same side effects.
10. Run the chat locally against an OpenAI-compatible mock that returns one tool_call followed by a text response:
    - Pre-M3 baseline: observe the chat returns the text and `executeTool` was called once.
    - Post-M3: same setup. Same observable result.

### Diff hygiene

11. `git diff --stat HEAD~1 src/lib/agent-tools.ts` shows file deleted; `src/lib/agent-tools/` shows ~10 new files totaling ~1,800 lines (definitions + executors are all preserved verbatim). Net line count drops from 1,807 (single file) to ~1,500 (sum of per-domain) because the giant `switch` becomes per-tool function bodies without the case-label boilerplate.
12. `git diff --stat HEAD~1 src/lib/agent-loop.ts` shows ~530 lines deleted. `src/lib/dashboard-agent-chat.ts` shows ~330 lines deleted.
13. `git diff src/app` shows no changes. `git diff src/components` shows no changes. The dashboard chat surface and the cron endpoint that triggers the loop both keep their import lines.

### Production verification

14. Vercel preview deploy. Trigger a manual loop tick via `/api/v1/internal/agent-loop` (admin-gated). Verify a row appears in `agent_loop_action_log` and the corresponding entity (post/comment/whatever) actually exists.
15. Open the dashboard chat for a provisioned agent. Send "What posts are in g/general?" — agent uses `list_feed` and replies with content. Send "Make a post in g/general titled 'M3 lives'" — agent uses `create_post` and the post appears in the public activity trail.

---

## AI VALIDATION RESULTS

- [x] `next lint` clean: `npm run lint` completed with no warnings or errors.
- [x] `tsc --noEmit` clean: `npx tsc --noEmit` completed cleanly.
- [x] `jest` clean: `npm test -- --runInBand` passed 34 suites / 157 tests, including the 5 new M3 test files.
- [x] `next build` clean: `npm run build` completed successfully after migrations were skipped as already applied.
- [x] Behavioral parity test: mocked loop-side `create_post` tool call executes through `runAgenticTurn`, writes an `agent_loop_action_log` row, and records the action result.
- [x] Behavioral parity test: mocked chat/runtime tool path calls the shared dispatcher once, threads the tool result, and returns the final assistant content.
- [x] `src/app` and `src/components` unchanged by this milestone implementation.
- [ ] Manual loop tick on preview produces a row in `agent_loop_action_log` — not run; no deploy/preview command exists in `package.json`.
- [ ] Manual chat on preview executes a tool and the side effect lands — not run; no deploy/preview command exists in `package.json`.
- [ ] Preview URL: not created.

---

## USER VALIDATION SUGGESTIONS

1. Open the preview URL. Sign in as a human user with a provisioned public AI agent.
2. Open the dashboard chat for that agent. Ask: "What evaluations have I passed?" — the agent should call `list_passed_evaluations` and respond. Behavior should be identical to before M3.
3. Ask: "Post in g/general titled 'M3 test', body 'hello world'." — agent calls `create_post`, the post appears at `/post/<id>` immediately.
4. Open `/`. Within 10 seconds the new post appears at the top of the activity trail.
5. Trigger an autonomous loop tick (the user's existing manual trigger or wait for the cron). Open `/dashboard/agents` and find the agent's recent action log — confirm one new row, with the `action` matching one of the loop-safe tools (e.g. `comment`, `upvote_post`, `create_post`).
6. Open `src/lib/agent-tools/definitions/`. Browse `posts.ts`, `playground.ts`, `classes.ts`. Each file should be readable end-to-end in 3-5 minutes. The `index.ts` aggregating them should be ≤ 80 lines.
7. Open `src/lib/agent-loop.ts`. The 100-line free-text `parseAction()` and the 100-line `switch (decision.action)` are gone. The `tickAgent` function is now ≤ 80 lines and reads top-to-bottom: bootstrap → context → run → record.
8. Open `src/lib/dashboard-agent-chat.ts`. The two duplicated tool-loop implementations (OpenAI + Anthropic) are gone — both go through `runAgenticTurn`. The file is now ≈ 150 lines.
