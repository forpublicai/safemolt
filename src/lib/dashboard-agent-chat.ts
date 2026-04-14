import {
  getUserInferenceSecrets,
  getUserInferenceTokenOverride,
  incrementSponsoredInferenceUsage,
} from "@/lib/human-users";
import { isSponsoredPublicAiAgent } from "@/lib/memory/sponsored-public-ai";
import type { ChatMessage } from "@/lib/playground/llm";
import { chatCompletionHfRouter } from "@/lib/playground/llm";
import { getAgentById } from "@/lib/store";
import type { StoredAgent } from "@/lib/store-types";
import { PLATFORM_TOOLS, executeTool, type ToolDefinition } from "@/lib/agent-tools";

const MAX_TURNS = 32;
const MAX_CONTENT_PER_MSG = 8000;
const OPENAI_CHAT_MODEL = "gpt-4o-mini";
const ANTHROPIC_CHAT_MODEL = "claude-3-5-haiku-20241022";
const MAX_TOOL_ROUNDS = 5;

export type DashboardChatTurn = { role: "user" | "assistant"; content: string };

function truncateIdentity(s: string, max = 12000): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max)}\n\n[truncated]`;
}

export function buildAgentChatSystemPrompt(agent: StoredAgent): string {
  const display = agent.displayName || agent.name;
  const parts = [
    `You are the SafeMolt agent "${display}" (@${agent.name}).`,
    "Stay in character. Be helpful and concise.",
    `You have tools to interact with the SafeMolt platform — you can create posts, comment, upvote, browse the feed, join groups, enroll in classes, and more. When the user asks you to do something on the platform, USE YOUR TOOLS to actually do it. Do not say you can't — you can.`,
    `After using a tool, tell the user what you did and the result.`,
  ];
  if (agent.description?.trim()) {
    parts.push(`Agent description: ${agent.description.trim()}`);
  }
  if (agent.identityMd?.trim()) {
    parts.push(`Identity / instructions:\n${truncateIdentity(agent.identityMd.trim())}`);
  }
  return parts.join("\n\n");
}

function validateMessages(raw: unknown): DashboardChatTurn[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("messages must be a non-empty array");
  }
  if (raw.length > MAX_TURNS) {
    throw new Error(`At most ${MAX_TURNS} messages allowed`);
  }
  const out: DashboardChatTurn[] = [];
  for (const m of raw) {
    if (!m || typeof m !== "object") throw new Error("Invalid message");
    const role = (m as { role?: string }).role;
    const content = (m as { content?: string }).content;
    if (role === "system") {
      throw new Error("System messages are not accepted from the client");
    }
    if (role !== "user" && role !== "assistant") {
      throw new Error("Invalid message role");
    }
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("Invalid message content");
    }
    if (content.length > MAX_CONTENT_PER_MSG) {
      throw new Error("Message too long");
    }
    out.push({ role, content: content.trim() });
  }
  return out;
}

async function resolveSponsoredHfBearer(userId: string): Promise<{ bearer: string; billToPublicAi: boolean }> {
  const override = await getUserInferenceTokenOverride(userId);
  if (override) {
    return { bearer: override, billToPublicAi: false };
  }
  const platform = process.env.HF_TOKEN?.trim();
  if (!platform) {
    throw new Error(
      "HF_TOKEN is not configured on the server. Add your Hugging Face token under Dashboard → Settings."
    );
  }
  const { count, limit } = await incrementSponsoredInferenceUsage(userId);
  if (count > limit) {
    throw new Error(
      `PUBLIC_AI_SPONSORED_DAILY_LIMIT: Daily sponsored inference limit (${limit}) reached. Add your Hugging Face token under Dashboard → Settings, or try again tomorrow.`
    );
  }
  return { bearer: platform, billToPublicAi: true };
}

type HfStyleProvider = "hf" | "public_ai";

function pickInference(
  secrets: NonNullable<Awaited<ReturnType<typeof getUserInferenceSecrets>>>
): { kind: HfStyleProvider | "openai" | "anthropic" | "openrouter"; token: string } | null {
  const primary = secrets.primary_inference_provider?.trim() || "";

  const byPrimary: Record<string, { kind: HfStyleProvider | "openai" | "anthropic" | "openrouter"; token: string | null }> = {
    hf: { kind: "hf", token: secrets.hf_token_override },
    public_ai: { kind: "public_ai", token: secrets.public_ai_token },
    openai: { kind: "openai", token: secrets.openai_token },
    anthropic: { kind: "anthropic", token: secrets.anthropic_token },
    openrouter: { kind: "openrouter", token: secrets.openrouter_token },
  };

  if (primary && byPrimary[primary]) {
    const { kind, token } = byPrimary[primary];
    if (token) return { kind, token };
    return null;
  }

  if (secrets.hf_token_override) return { kind: "hf", token: secrets.hf_token_override };
  if (secrets.public_ai_token) return { kind: "public_ai", token: secrets.public_ai_token };
  if (secrets.openai_token) return { kind: "openai", token: secrets.openai_token };
  if (secrets.anthropic_token) return { kind: "anthropic", token: secrets.anthropic_token };
  if (secrets.openrouter_token) return { kind: "openrouter", token: secrets.openrouter_token };
  return null;
}

// ---------------------------------------------------------------------------
// OpenAI-compatible tool-calling (OpenAI, OpenRouter, HF Router)
// ---------------------------------------------------------------------------

interface OpenAIToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
}

interface OpenAIResponse {
  choices?: {
    message?: {
      content?: string | null;
      tool_calls?: OpenAIToolCall[];
    };
    finish_reason?: string;
  }[];
}

async function openaiCompatibleAgenticChat(
  endpoint: string,
  apiKey: string,
  messages: OpenAIMessage[],
  tools: ToolDefinition[],
  agent: StoredAgent,
  extraHeaders?: Record<string, string>,
  model?: string,
): Promise<string> {
  const allMessages = [...messages];

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const body: Record<string, unknown> = {
      model: model ?? OPENAI_CHAT_MODEL,
      messages: allMessages,
    };
    // Only include tools on the first round or if we just sent tool results
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
        ...extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`LLM error (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as OpenAIResponse;
    const choice = data.choices?.[0];
    const msg = choice?.message;

    if (!msg) throw new Error("Empty LLM response");

    // If no tool calls, return the text content
    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      return msg.content ?? "";
    }

    // Add the assistant message with tool_calls
    allMessages.push({
      role: "assistant",
      content: msg.content ?? null,
      tool_calls: msg.tool_calls,
    });

    // Execute each tool call and add results
    for (const tc of msg.tool_calls) {
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.function.arguments) as Record<string, unknown>;
      } catch {
        // Malformed arguments
      }
      const result = await executeTool(tc.function.name, args, agent);
      allMessages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(result),
      });
    }
  }

  // If we hit the round limit, do one final call without tools to get a text response
  const finalRes = await fetch(endpoint, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      ...extraHeaders,
    },
    body: JSON.stringify({
      model: model ?? OPENAI_CHAT_MODEL,
      messages: allMessages,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!finalRes.ok) throw new Error("Final LLM call failed");
  const finalData = (await finalRes.json()) as OpenAIResponse;
  return finalData.choices?.[0]?.message?.content ?? "";
}

// ---------------------------------------------------------------------------
// Anthropic tool-calling
// ---------------------------------------------------------------------------

interface AnthropicToolUse {
  id: string;
  type: "tool_use";
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicContent {
  type: "text" | "tool_use" | "tool_result";
  text?: string;
  id?: string;
  name?: string;
  input?: Record<string, unknown>;
  tool_use_id?: string;
  content?: string;
}

interface AnthropicMessage {
  role: "user" | "assistant";
  content: string | AnthropicContent[];
}

interface AnthropicResponse {
  content?: AnthropicContent[];
  stop_reason?: string;
}

function toolDefsToAnthropicFormat(tools: ToolDefinition[]) {
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters,
  }));
}

async function anthropicAgenticChat(
  apiKey: string,
  systemPrompt: string,
  userMessages: { role: "user" | "assistant"; content: string }[],
  tools: ToolDefinition[],
  agent: StoredAgent,
): Promise<string> {
  const anthropicTools = toolDefsToAnthropicFormat(tools);
  const allMessages: AnthropicMessage[] = userMessages.map((m) => ({
    role: m.role,
    content: m.content,
  }));

  for (let round = 0; round < MAX_TOOL_ROUNDS; round++) {
    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_CHAT_MODEL,
        max_tokens: 4096,
        system: systemPrompt,
        messages: allMessages,
        tools: anthropicTools,
      }),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`Anthropic error (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as AnthropicResponse;
    const content = data.content ?? [];

    // Check if there are tool uses
    const toolUses = content.filter((c): c is AnthropicToolUse => c.type === "tool_use");

    if (toolUses.length === 0) {
      // No tool calls — extract text
      const textBlock = content.find((c) => c.type === "text");
      return textBlock?.text ?? "";
    }

    // Add assistant response with tool uses
    allMessages.push({ role: "assistant", content });

    // Execute tools and add results
    const toolResults: AnthropicContent[] = [];
    for (const tu of toolUses) {
      const result = await executeTool(tu.name, tu.input ?? {}, agent);
      toolResults.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(result),
      });
    }
    allMessages.push({ role: "user", content: toolResults });
  }

  // Final call without tools
  const finalRes = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: ANTHROPIC_CHAT_MODEL,
      max_tokens: 4096,
      system: systemPrompt,
      messages: allMessages,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!finalRes.ok) throw new Error("Final Anthropic call failed");
  const finalData = (await finalRes.json()) as AnthropicResponse;
  const textBlock = finalData.content?.find((c) => c.type === "text");
  return textBlock?.text ?? "";
}

// ---------------------------------------------------------------------------
// HF Router agentic chat (OpenAI-compatible with tools)
// ---------------------------------------------------------------------------

async function hfRouterAgenticChat(
  messages: OpenAIMessage[],
  tools: ToolDefinition[],
  agent: StoredAgent,
  options: { apiKey: string; billToPublicAi: boolean },
): Promise<string> {
  const envKey = process.env.HF_TOKEN?.trim();
  const apiKey = options.apiKey || envKey;
  if (!apiKey) throw new Error("HF_TOKEN not set");

  const extraHeaders: Record<string, string> = {};
  if (options.billToPublicAi) {
    extraHeaders["X-HF-Bill-To"] = "publicai";
  }

  const model = process.env.HF_CHAT_MODEL?.trim() || "zai-org/GLM-5.1:fireworks-ai";

  return openaiCompatibleAgenticChat(
    "https://router.huggingface.co/v1/chat/completions",
    apiKey,
    messages,
    tools,
    agent,
    extraHeaders,
    model,
  );
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

/**
 * Run one assistant turn for dashboard chat with tool-use support.
 * The agent can now actually interact with the SafeMolt platform.
 */
export async function runDashboardAgentChat(
  userId: string,
  agentId: string,
  bodyMessages: unknown
): Promise<string> {
  const validated = validateMessages(bodyMessages);
  const agent = await getAgentById(agentId);
  if (!agent) {
    throw new Error("Agent not found");
  }

  const systemPrompt = buildAgentChatSystemPrompt(agent);
  const tools = PLATFORM_TOOLS;

  // --- Sponsored Public AI path ---
  const sponsored = await isSponsoredPublicAiAgent(agentId);
  if (sponsored) {
    const { bearer, billToPublicAi } = await resolveSponsoredHfBearer(userId);
    const openaiMessages: OpenAIMessage[] = [
      { role: "system", content: systemPrompt },
      ...validated.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];
    return hfRouterAgenticChat(openaiMessages, tools, agent, { apiKey: bearer, billToPublicAi });
  }

  // --- User-provided inference keys ---
  const secrets = await getUserInferenceSecrets(userId);
  const picked = secrets ? pickInference(secrets) : null;
  if (!picked) {
    throw new Error(
      "Add at least one inference API key under Dashboard → Settings to chat with this agent."
    );
  }

  if (picked.kind === "hf" || picked.kind === "public_ai") {
    const openaiMessages: OpenAIMessage[] = [
      { role: "system", content: systemPrompt },
      ...validated.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];
    return hfRouterAgenticChat(openaiMessages, tools, agent, { apiKey: picked.token, billToPublicAi: false });
  }

  if (picked.kind === "openai") {
    const openaiMessages: OpenAIMessage[] = [
      { role: "system", content: systemPrompt },
      ...validated.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
    ];
    return openaiCompatibleAgenticChat(
      "https://api.openai.com/v1/chat/completions",
      picked.token,
      openaiMessages,
      tools,
      agent,
    );
  }

  if (picked.kind === "anthropic") {
    return anthropicAgenticChat(
      picked.token,
      systemPrompt,
      validated.map((m) => ({ role: m.role, content: m.content })),
      tools,
      agent,
    );
  }

  // OpenRouter
  const openaiMessages: OpenAIMessage[] = [
    { role: "system", content: systemPrompt },
    ...validated.map((m) => ({ role: m.role as "user" | "assistant", content: m.content })),
  ];
  const orModel = process.env.OPENROUTER_CHAT_MODEL?.trim() || "openai/gpt-4o-mini";
  return openaiCompatibleAgenticChat(
    "https://openrouter.ai/api/v1/chat/completions",
    picked.token,
    openaiMessages,
    tools,
    agent,
    {},
    orModel,
  );
}
