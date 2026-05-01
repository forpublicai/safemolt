import type { ToolDefinition } from "@/lib/agent-tools";
import type { CallLLM, NormalizedLLMResponse, NormalizedMessage, NormalizedToolCall } from "@/lib/agent-runtime";

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
  }[];
}

export interface OpenAICompatibleOptions {
  endpoint: string;
  apiKey: string;
  model: string;
  extraHeaders?: Record<string, string>;
  timeoutMs?: number;
}

function parseToolArguments(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
}

function toOpenAIMessage(message: NormalizedMessage): OpenAIMessage {
  if (message.role === "assistant") {
    return {
      role: "assistant",
      content: message.content || null,
      tool_calls: message.toolCalls?.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: JSON.stringify(call.arguments) },
      })),
    };
  }
  if (message.role === "tool") {
    return { role: "tool", content: message.content, tool_call_id: message.toolCallId };
  }
  return { role: message.role, content: message.content };
}

function normalizeToolCall(toolCall: OpenAIToolCall): NormalizedToolCall {
  return {
    id: toolCall.id,
    name: toolCall.function.name,
    arguments: parseToolArguments(toolCall.function.arguments),
  };
}

export function makeOpenAICompatibleCallLLM(options: OpenAICompatibleOptions): CallLLM {
  return async (messages: NormalizedMessage[], tools: ToolDefinition[]): Promise<NormalizedLLMResponse> => {
    const body: Record<string, unknown> = {
      model: options.model,
      messages: messages.map(toOpenAIMessage),
    };
    if (tools.length > 0) {
      body.tools = tools;
      body.tool_choice = "auto";
    }

    const res = await fetch(options.endpoint, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${options.apiKey}`,
        "Content-Type": "application/json",
        ...options.extraHeaders,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(options.timeoutMs ?? 60_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`LLM error (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as OpenAIResponse;
    const message = data.choices?.[0]?.message;
    if (!message) throw new Error("Empty LLM response");

    return {
      content: message.content ?? null,
      toolCalls: (message.tool_calls ?? []).map(normalizeToolCall),
      rawAssistant: message,
    };
  };
}

export function makeHfRouterCallLLM(options: {
  apiKey: string;
  billToPublicAi: boolean;
  model?: string;
}): CallLLM {
  return makeOpenAICompatibleCallLLM({
    endpoint: "https://router.huggingface.co/v1/chat/completions",
    apiKey: options.apiKey,
    model: options.model || process.env.HF_CHAT_MODEL?.trim() || "zai-org/GLM-5.1:fireworks-ai",
    extraHeaders: options.billToPublicAi ? { "X-HF-Bill-To": "publicai" } : undefined,
  });
}

export function makeOpenAiCallLLM(apiKey: string, model = "gpt-4o-mini"): CallLLM {
  return makeOpenAICompatibleCallLLM({
    endpoint: "https://api.openai.com/v1/chat/completions",
    apiKey,
    model,
  });
}

export function makeOpenRouterCallLLM(apiKey: string, model: string): CallLLM {
  return makeOpenAICompatibleCallLLM({
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    apiKey,
    model,
  });
}
