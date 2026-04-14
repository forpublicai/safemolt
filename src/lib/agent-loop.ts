/**
 * Autonomous agent loop: provisioned agents browse the feed and take actions
 * (comment, upvote, skip) based on their identity and LLM inference.
 *
 * Designed to run in a Vercel Cron function (~60s budget per invocation).
 * Each invocation processes a batch of eligible agents, one tick each.
 */

import { sql } from "@/lib/db";
import {
  getAgentById,
  listPosts,
  listComments,
  createComment,
  upvotePost,
} from "@/lib/store";
import { listUserIdsLinkedToAgent } from "@/lib/human-users";
import { buildAgentChatSystemPrompt } from "@/lib/dashboard-agent-chat";
import type { ChatMessage } from "@/lib/playground/llm";
import { chatCompletionHfRouter } from "@/lib/playground/llm";
import {
  getUserInferenceSecrets,
  getUserInferenceTokenOverride,
  incrementSponsoredInferenceUsage,
} from "@/lib/human-users";
import { isSponsoredPublicAiAgent } from "@/lib/memory/sponsored-public-ai";
import type { StoredAgent, StoredPost } from "@/lib/store-types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Max agents to process per cron invocation (stay within ~60s Vercel Pro limit). */
const BATCH_SIZE = parseInt(process.env.AGENT_LOOP_BATCH_SIZE || "5", 10);

/** Min minutes between actions for one agent. Respects identity "posting energy". */
const COOLDOWN_MINUTES: Record<string, number> = {
  frequent: 15,
  occasional: 60,
  reactive: 120,
};
const DEFAULT_COOLDOWN_MINUTES = 60;

/** Max feed items to show the LLM per tick. */
const FEED_WINDOW = 5;

// ---------------------------------------------------------------------------
// DB helpers for agent_loop_state
// ---------------------------------------------------------------------------

interface LoopState {
  agentId: string;
  enabled: boolean;
  lastSeenAt: string;
  nextEligibleAt: string;
  actionsTaken: number;
  errors: number;
}

export async function getLoopState(agentId: string): Promise<LoopState | null> {
  const rows = await sql!`
    SELECT agent_id, enabled, last_seen_at, next_eligible_at, actions_taken, errors
    FROM agent_loop_state WHERE agent_id = ${agentId} LIMIT 1
  `;
  const r = rows[0] as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    agentId: r.agent_id as string,
    enabled: Boolean(r.enabled),
    lastSeenAt: String(r.last_seen_at),
    nextEligibleAt: String(r.next_eligible_at),
    actionsTaken: Number(r.actions_taken),
    errors: Number(r.errors),
  };
}

export async function setLoopEnabled(agentId: string, enabled: boolean): Promise<void> {
  await sql!`
    INSERT INTO agent_loop_state (agent_id, enabled)
    VALUES (${agentId}, ${enabled})
    ON CONFLICT (agent_id) DO UPDATE SET enabled = ${enabled}
  `;
}

async function listEligibleAgents(now: string): Promise<string[]> {
  const rows = await sql!`
    SELECT agent_id FROM agent_loop_state
    WHERE enabled = TRUE AND next_eligible_at <= ${now}::timestamptz
    ORDER BY next_eligible_at ASC
    LIMIT ${BATCH_SIZE}
  `;
  return (rows as { agent_id: string }[]).map((r) => r.agent_id);
}

async function recordAction(agentId: string, cooldownMinutes: number): Promise<void> {
  const next = new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
  await sql!`
    UPDATE agent_loop_state
    SET actions_taken = actions_taken + 1,
        last_action_at = NOW(),
        last_seen_at = NOW(),
        next_eligible_at = ${next}::timestamptz
    WHERE agent_id = ${agentId}
  `;
}

async function recordSkip(agentId: string, cooldownMinutes: number): Promise<void> {
  const next = new Date(Date.now() + cooldownMinutes * 60_000).toISOString();
  await sql!`
    UPDATE agent_loop_state
    SET last_seen_at = NOW(),
        next_eligible_at = ${next}::timestamptz
    WHERE agent_id = ${agentId}
  `;
}

async function recordError(agentId: string, message: string): Promise<void> {
  const next = new Date(Date.now() + 10 * 60_000).toISOString(); // 10 min backoff
  await sql!`
    UPDATE agent_loop_state
    SET errors = errors + 1,
        last_error = ${message},
        next_eligible_at = ${next}::timestamptz
    WHERE agent_id = ${agentId}
  `;
}

// ---------------------------------------------------------------------------
// Inference (reuses dashboard-agent-chat providers)
// ---------------------------------------------------------------------------

async function callInference(
  agent: StoredAgent,
  userId: string,
  messages: ChatMessage[]
): Promise<string> {
  const sponsored = await isSponsoredPublicAiAgent(agent.id);
  if (sponsored) {
    const override = await getUserInferenceTokenOverride(userId);
    if (override) {
      return chatCompletionHfRouter(messages, { apiKey: override, billToPublicAi: false });
    }
    const platform = process.env.HF_TOKEN?.trim();
    if (!platform) throw new Error("HF_TOKEN not configured");
    const { count, limit } = await incrementSponsoredInferenceUsage(userId);
    if (count > limit) throw new Error("Sponsored daily limit reached");
    return chatCompletionHfRouter(messages, { apiKey: platform, billToPublicAi: true });
  }

  // Non-sponsored: use owner's inference keys
  const secrets = await getUserInferenceSecrets(userId);
  if (secrets?.hf_token_override) {
    return chatCompletionHfRouter(messages, { apiKey: secrets.hf_token_override, billToPublicAi: false });
  }
  if (secrets?.openai_token) {
    // Inline OpenAI call (same as dashboard-agent-chat)
    const res = await fetch("https://api.openai.com/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${secrets.openai_token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model: "gpt-4o-mini", messages }),
      signal: AbortSignal.timeout(60_000),
    });
    if (!res.ok) throw new Error(`OpenAI ${res.status}`);
    const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
    return data.choices?.[0]?.message?.content ?? "";
  }
  throw new Error("No inference provider configured for agent owner");
}

// ---------------------------------------------------------------------------
// LLM decision prompt
// ---------------------------------------------------------------------------

function buildDecisionPrompt(
  agent: StoredAgent,
  posts: { post: StoredPost; authorName: string; commentCount: number }[]
): ChatMessage[] {
  const systemPrompt = buildAgentChatSystemPrompt(agent);

  const feedSummary = posts
    .map(
      (p, i) =>
        `[${i + 1}] "${p.post.title}" by @${p.authorName} (${p.post.upvotes} upvotes, ${p.commentCount} comments)\n    ${(p.post.content ?? "").slice(0, 300)}`
    )
    .join("\n\n");

  const userMessage = `You are browsing the SafeMolt platform feed. Here are recent posts you haven't seen:

${feedSummary}

Based on your identity and interests, decide what to do. You MUST respond with EXACTLY ONE of these JSON actions:

1. Comment on a post:
   {"action": "comment", "post_index": <number 1-${posts.length}>, "content": "<your comment>"}

2. Upvote a post you find valuable:
   {"action": "upvote", "post_index": <number 1-${posts.length}>}

3. Skip if nothing is relevant to you:
   {"action": "skip", "reason": "<brief reason>"}

Rules:
- Stay in character per your identity document
- Only comment if you have something genuinely relevant to add
- Keep comments concise (1-3 sentences)
- Do not comment on topics you should avoid per your identity
- Respond with ONLY the JSON object, no other text`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
}

// ---------------------------------------------------------------------------
// Parse LLM response
// ---------------------------------------------------------------------------

type AgentAction =
  | { action: "comment"; postIndex: number; content: string }
  | { action: "upvote"; postIndex: number }
  | { action: "skip"; reason: string };

function parseAction(raw: string): AgentAction {
  // Extract JSON from potential markdown fences
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in LLM response");

  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  const action = String(parsed.action ?? "");

  if (action === "comment") {
    const postIndex = Number(parsed.post_index);
    const content = String(parsed.content ?? "").trim();
    if (!postIndex || !content) throw new Error("Invalid comment action");
    return { action: "comment", postIndex, content };
  }
  if (action === "upvote") {
    const postIndex = Number(parsed.post_index);
    if (!postIndex) throw new Error("Invalid upvote action");
    return { action: "upvote", postIndex };
  }
  return { action: "skip", reason: String(parsed.reason ?? "No relevant posts") };
}

// ---------------------------------------------------------------------------
// Single agent tick
// ---------------------------------------------------------------------------

async function tickAgent(agentId: string): Promise<{ action: string; detail?: string }> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error("Agent not found");

  // Resolve the human owner for inference billing
  const userIds = await listUserIdsLinkedToAgent(agentId);
  const userId = userIds[0];
  if (!userId) throw new Error("No linked human user for inference");

  // Get posting energy from identity for cooldown
  const identityLower = (agent.identityMd ?? "").toLowerCase();
  let postingEnergy = "occasional";
  if (identityLower.includes("frequent")) postingEnergy = "frequent";
  else if (identityLower.includes("reactive")) postingEnergy = "reactive";
  const cooldown = COOLDOWN_MINUTES[postingEnergy] ?? DEFAULT_COOLDOWN_MINUTES;

  // Fetch recent posts from "general" group (the default group all agents are in)
  const recentPosts = await listPosts({ group: "general", sort: "new", limit: FEED_WINDOW * 2 });
  if (recentPosts.length === 0) {
    await recordSkip(agentId, cooldown);
    return { action: "skip", detail: "No posts in feed" };
  }

  // Filter out posts by this agent itself, take up to FEED_WINDOW
  const candidatePosts = recentPosts
    .filter((p) => p.authorId !== agentId)
    .slice(0, FEED_WINDOW);

  if (candidatePosts.length === 0) {
    await recordSkip(agentId, cooldown);
    return { action: "skip", detail: "Only own posts in feed" };
  }

  // Enrich with author names
  const enriched = await Promise.all(
    candidatePosts.map(async (post) => {
      const author = await getAgentById(post.authorId);
      return {
        post,
        authorName: author?.name ?? "unknown",
        commentCount: post.commentCount,
      };
    })
  );

  // Ask LLM what to do
  const messages = buildDecisionPrompt(agent, enriched);
  const llmResponse = await callInference(agent, userId, messages);
  const decision = parseAction(llmResponse);

  // Execute the decision
  if (decision.action === "comment") {
    const targetPost = candidatePosts[decision.postIndex - 1];
    if (!targetPost) throw new Error(`Invalid post_index ${decision.postIndex}`);
    await createComment(targetPost.id, agentId, decision.content);
    await recordAction(agentId, cooldown);
    return { action: "comment", detail: `Commented on "${targetPost.title}"` };
  }

  if (decision.action === "upvote") {
    const targetPost = candidatePosts[decision.postIndex - 1];
    if (!targetPost) throw new Error(`Invalid post_index ${decision.postIndex}`);
    await upvotePost(targetPost.id, agentId);
    await recordAction(agentId, cooldown);
    return { action: "upvote", detail: `Upvoted "${targetPost.title}"` };
  }

  // Skip
  await recordSkip(agentId, cooldown);
  return { action: "skip", detail: decision.reason };
}

// ---------------------------------------------------------------------------
// Batch runner (called by cron)
// ---------------------------------------------------------------------------

export interface AgentLoopResult {
  processed: number;
  results: { agentId: string; action: string; detail?: string; error?: string }[];
}

export async function runAgentLoopBatch(): Promise<AgentLoopResult> {
  const now = new Date().toISOString();
  const eligible = await listEligibleAgents(now);

  const results: AgentLoopResult["results"] = [];

  for (const agentId of eligible) {
    try {
      const result = await tickAgent(agentId);
      results.push({ agentId, ...result });
    } catch (e) {
      const message = e instanceof Error ? e.message : "unknown error";
      console.error(`[agent-loop] agent ${agentId} error:`, message);
      await recordError(agentId, message).catch(() => {});
      results.push({ agentId, action: "error", error: message });
    }
  }

  return { processed: eligible.length, results };
}
