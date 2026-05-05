import type { ToolDefinition } from "@/lib/agent-tools";
import type { CallLLM, NormalizedLLMResponse, NormalizedMessage } from "@/lib/agent-runtime";

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
}

function toolDefsToAnthropicFormat(tools: ToolDefinition[]) {
  return tools.map((tool) => ({
    name: tool.function.name,
    description: tool.function.description,
    input_schema: tool.function.parameters,
  }));
}

function toAnthropicMessages(messages: NormalizedMessage[]): { system: string; messages: AnthropicMessage[] } {
  const system = messages.filter((m) => m.role === "system").map((m) => m.content).join("\n\n");
  const out: AnthropicMessage[] = [];

  for (const message of messages) {
    if (message.role === "system") continue;
    if (message.role === "tool") {
      const content = { type: "tool_result" as const, tool_use_id: message.toolCallId, content: message.content };
      const previous = out[out.length - 1];
      if (previous?.role === "user" && Array.isArray(previous.content)) {
        previous.content.push(content);
      } else {
        out.push({ role: "user", content: [content] });
      }
      continue;
    }
    if (message.role === "assistant" && message.toolCalls?.length) {
      const content: AnthropicContent[] = [];
      if (message.content) content.push({ type: "text", text: message.content });
      content.push(...message.toolCalls.map((call) => ({
        type: "tool_use" as const,
        id: call.id,
        name: call.name,
        input: call.arguments,
      })));
      out.push({ role: "assistant", content });
      continue;
    }
    out.push({ role: message.role, content: message.content });
  }

  return { system, messages: out };
}

export function makeAnthropicCallLLM(apiKey: string, model = "claude-3-5-haiku-20241022"): CallLLM {
  return async (messages: NormalizedMessage[], tools: ToolDefinition[]): Promise<NormalizedLLMResponse> => {
    const formatted = toAnthropicMessages(messages);
    const body: Record<string, unknown> = {
      model,
      max_tokens: 4096,
      system: formatted.system,
      messages: formatted.messages,
    };
    if (tools.length > 0) body.tools = toolDefsToAnthropicFormat(tools);

    const res = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "Unknown error");
      throw new Error(`Anthropic error (${res.status}): ${errText}`);
    }

    const data = (await res.json()) as AnthropicResponse;
    const content = data.content ?? [];
    const text = content.filter((block) => block.type === "text").map((block) => block.text ?? "").join("\n");
    const toolCalls = content
      .filter((block): block is AnthropicToolUse => block.type === "tool_use")
      .map((block) => ({ id: block.id, name: block.name, arguments: block.input ?? {} }));

    return { content: text || null, toolCalls, rawAssistant: content };
  };
}
