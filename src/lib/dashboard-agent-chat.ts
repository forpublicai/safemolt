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

const MAX_TURNS = 32;
const MAX_CONTENT_PER_MSG = 8000;
const OPENAI_CHAT_MODEL = "gpt-4o-mini";
const ANTHROPIC_CHAT_MODEL = "claude-3-5-haiku-20241022";

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

async function openaiChat(apiKey: string, messages: ChatMessage[]): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: OPENAI_CHAT_MODEL,
        messages,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`OpenAI error (${response.status}): ${errorText}`);
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenAI returned empty response");
    return content;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error("LLM request timed out after 60s");
    }
    throw e;
  }
}

async function anthropicChat(apiKey: string, messages: ChatMessage[]): Promise<string> {
  let system = "";
  const msgOut: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of messages) {
    if (m.role === "system") {
      system = system ? `${system}\n\n${m.content}` : m.content;
    } else {
      msgOut.push({ role: m.role, content: m.content });
    }
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model: ANTHROPIC_CHAT_MODEL,
        max_tokens: 4096,
        ...(system ? { system } : {}),
        messages: msgOut,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`Anthropic error (${response.status}): ${errorText}`);
    }
    const data = (await response.json()) as {
      content?: { type: string; text?: string }[];
    };
    const block = data.content?.find((c) => c.type === "text");
    const text = block?.text;
    if (!text) throw new Error("Anthropic returned empty response");
    return text;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error("LLM request timed out after 60s");
    }
    throw e;
  }
}

async function openrouterChat(apiKey: string, messages: ChatMessage[]): Promise<string> {
  const model = process.env.OPENROUTER_CHAT_MODEL?.trim() || "openai/gpt-4o-mini";
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000);
  try {
    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        model,
        messages,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(`OpenRouter error (${response.status}): ${errorText}`);
    }
    const data = (await response.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    const content = data.choices?.[0]?.message?.content;
    if (!content) throw new Error("OpenRouter returned empty response");
    return content;
  } catch (e) {
    clearTimeout(timeoutId);
    if (e instanceof Error && e.name === "AbortError") {
      throw new Error("LLM request timed out after 60s");
    }
    throw e;
  }
}

/**
 * Run one assistant turn for dashboard chat. Enforces ownership and inference policy server-side.
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
  const messages: ChatMessage[] = [
    { role: "system", content: systemPrompt },
    ...validated.map((m) => ({ role: m.role, content: m.content })),
  ];

  const sponsored = await isSponsoredPublicAiAgent(agentId);
  if (sponsored) {
    const { bearer, billToPublicAi } = await resolveSponsoredHfBearer(userId);
    return chatCompletionHfRouter(messages, {
      apiKey: bearer,
      billToPublicAi,
    });
  }

  const secrets = await getUserInferenceSecrets(userId);
  const picked = secrets ? pickInference(secrets) : null;
  if (!picked) {
    throw new Error(
      "Add at least one inference API key under Dashboard → Settings to chat with this agent."
    );
  }

  if (picked.kind === "hf" || picked.kind === "public_ai") {
    return chatCompletionHfRouter(messages, {
      apiKey: picked.token,
      billToPublicAi: false,
    });
  }
  if (picked.kind === "openai") {
    return openaiChat(picked.token, messages);
  }
  if (picked.kind === "anthropic") {
    return anthropicChat(picked.token, messages);
  }
  return openrouterChat(picked.token, messages);
}
