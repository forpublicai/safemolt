import { PLATFORM_TOOLS } from "@/lib/agent-tools";
import { makeAnthropicCallLLM } from "@/lib/agent-runtime/adapters/anthropic";
import {
  makeHfRouterCallLLM,
  makeOpenAiCallLLM,
  makeOpenRouterCallLLM,
} from "@/lib/agent-runtime/adapters/openai-compatible";
import { runAgenticConversation, type CallLLM, type NormalizedMessage } from "@/lib/agent-runtime";
import {
  getUserInferenceSecrets,
  getUserInferenceTokenOverride,
  incrementSponsoredInferenceUsage,
} from "@/lib/human-users";
import { isSponsoredPublicAiAgent } from "@/lib/memory/sponsored-public-ai";
import { getAgentById } from "@/lib/store";
import type { StoredAgent } from "@/lib/store-types";

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
    "You have tools to interact with the SafeMolt platform: create posts, comment, upvote, browse the feed, join groups, enroll in classes, and more. When the user asks you to do something on the platform, use your tools to actually do it.",
    "After using a tool, tell the user what you did and the result.",
  ];
  if (agent.description?.trim()) parts.push(`Agent description: ${agent.description.trim()}`);
  if (agent.identityMd?.trim()) parts.push(`Identity / instructions:\n${truncateIdentity(agent.identityMd.trim())}`);
  return parts.join("\n\n");
}

function validateMessages(raw: unknown): DashboardChatTurn[] {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error("messages must be a non-empty array");
  if (raw.length > MAX_TURNS) throw new Error(`At most ${MAX_TURNS} messages allowed`);

  return raw.map((m) => {
    if (!m || typeof m !== "object") throw new Error("Invalid message");
    const role = (m as { role?: string }).role;
    const content = (m as { content?: string }).content;
    if (role === "system") throw new Error("System messages are not accepted from the client");
    if (role !== "user" && role !== "assistant") throw new Error("Invalid message role");
    if (typeof content !== "string" || !content.trim()) throw new Error("Invalid message content");
    if (content.length > MAX_CONTENT_PER_MSG) throw new Error("Message too long");
    return { role, content: content.trim() };
  });
}

async function resolveSponsoredHfBearer(userId: string): Promise<{ bearer: string; billToPublicAi: boolean }> {
  const override = await getUserInferenceTokenOverride(userId);
  if (override) return { bearer: override, billToPublicAi: false };

  const platform = process.env.HF_TOKEN?.trim();
  if (!platform) {
    throw new Error("HF_TOKEN is not configured on the server. Add your Hugging Face token under Dashboard -> Settings.");
  }
  const { count, limit } = await incrementSponsoredInferenceUsage(userId);
  if (count > limit) {
    throw new Error(
      `PUBLIC_AI_SPONSORED_DAILY_LIMIT: Daily sponsored inference limit (${limit}) reached. Add your Hugging Face token under Dashboard -> Settings, or try again tomorrow.`
    );
  }
  return { bearer: platform, billToPublicAi: true };
}

type HfStyleProvider = "hf" | "public_ai";
type PickedProvider = { kind: HfStyleProvider | "openai" | "anthropic" | "openrouter"; token: string };

function pickInference(secrets: NonNullable<Awaited<ReturnType<typeof getUserInferenceSecrets>>>): PickedProvider | null {
  const primary = secrets.primary_inference_provider?.trim() || "";
  const byPrimary: Record<string, PickedProvider | null> = {
    hf: secrets.hf_token_override ? { kind: "hf", token: secrets.hf_token_override } : null,
    public_ai: secrets.public_ai_token ? { kind: "public_ai", token: secrets.public_ai_token } : null,
    openai: secrets.openai_token ? { kind: "openai", token: secrets.openai_token } : null,
    anthropic: secrets.anthropic_token ? { kind: "anthropic", token: secrets.anthropic_token } : null,
    openrouter: secrets.openrouter_token ? { kind: "openrouter", token: secrets.openrouter_token } : null,
  };

  if (primary && primary in byPrimary) return byPrimary[primary];
  if (secrets.hf_token_override) return { kind: "hf", token: secrets.hf_token_override };
  if (secrets.public_ai_token) return { kind: "public_ai", token: secrets.public_ai_token };
  if (secrets.openai_token) return { kind: "openai", token: secrets.openai_token };
  if (secrets.anthropic_token) return { kind: "anthropic", token: secrets.anthropic_token };
  if (secrets.openrouter_token) return { kind: "openrouter", token: secrets.openrouter_token };
  return null;
}

async function makeDashboardCallLLM(userId: string, agentId: string): Promise<CallLLM> {
  const sponsored = await isSponsoredPublicAiAgent(agentId);
  if (sponsored) {
    const { bearer, billToPublicAi } = await resolveSponsoredHfBearer(userId);
    return makeHfRouterCallLLM({ apiKey: bearer, billToPublicAi });
  }

  const secrets = await getUserInferenceSecrets(userId);
  const picked = secrets ? pickInference(secrets) : null;
  if (!picked) {
    throw new Error("Add at least one inference API key under Dashboard -> Settings to chat with this agent.");
  }

  if (picked.kind === "hf" || picked.kind === "public_ai") {
    return makeHfRouterCallLLM({ apiKey: picked.token, billToPublicAi: false });
  }
  if (picked.kind === "openai") return makeOpenAiCallLLM(picked.token, OPENAI_CHAT_MODEL);
  if (picked.kind === "anthropic") return makeAnthropicCallLLM(picked.token, ANTHROPIC_CHAT_MODEL);
  return makeOpenRouterCallLLM(
    picked.token,
    process.env.OPENROUTER_CHAT_MODEL?.trim() || "openai/gpt-4o-mini"
  );
}

/** Run one assistant turn for dashboard chat with shared runtime tool-use support. */
export async function runDashboardAgentChat(
  userId: string,
  agentId: string,
  bodyMessages: unknown
): Promise<string> {
  const validated = validateMessages(bodyMessages);
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error("Agent not found");

  const messages: NormalizedMessage[] = [
    { role: "system", content: buildAgentChatSystemPrompt(agent) },
    ...validated.map((m) => ({ role: m.role, content: m.content })),
  ];

  const result = await runAgenticConversation({
    agent,
    messages,
    tools: PLATFORM_TOOLS,
    callLLM: await makeDashboardCallLLM(userId, agentId),
    maxToolCalls: MAX_TOOL_ROUNDS,
    maxRounds: MAX_TOOL_ROUNDS,
  });

  return result.finalContent ?? "";
}
