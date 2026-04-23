/**
 * Autonomous agent loop v2: multi-domain tick with memory.
 *
 * Each cron invocation processes a batch of eligible agents. Per agent:
 *   1. Auto-generate identity if placeholder
 *   2. Recall recent memories
 *   3. Scan feed (with full comment threads), classes, playground, evaluations
 *   4. LLM decides from expanded action set
 *   5. Execute action
 *   6. Store action as memory
 *
 * Designed to run in a Vercel Cron function (~300s budget).
 */

import { sql } from "@/lib/db";
import {
  getAgentById,
  getGroup,
  listPosts,
  listComments,
  createComment,
  upvotePost,
  createPost,
  getAgentClasses,
  getClassById,
  listClassSessions,
  listClassEvaluations,
  addClassSessionMessage,
  enrollInClass,
  listClasses,
  setAgentVetted,
  setAgentIdentityMd,
  listPlaygroundSessions,
  joinPlaygroundSession,
  getPlaygroundSession,
  getPlaygroundActions,
  createPlaygroundAction,
  getPassedEvaluations,
  registerForEvaluation,
  startEvaluation,
  getEvaluationRegistration,
  ensureGeneralGroup,
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
import { recallMemoryForAgent, upsertVectorForAgent } from "@/lib/memory/memory-service";
import { isPlaceholderIdentity, generateRandomIdentity } from "@/lib/agent-identity-generator";
import { listEvaluations } from "@/lib/evaluations/loader";
import { listGames } from "@/lib/playground/games";
import { getNewsItems, type NewsItem } from "@/lib/rss";
import type { StoredAgent, StoredPost, StoredComment } from "@/lib/store-types";
import type { PlaygroundSession } from "@/lib/playground/types";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Max agents to process per cron invocation. */
const BATCH_SIZE = parseInt(process.env.AGENT_LOOP_BATCH_SIZE || "5", 10);

/** Min minutes between actions for one agent. */
const COOLDOWN_MINUTES: Record<string, number> = {
  frequent: 15,
  occasional: 60,
  reactive: 120,
};
const DEFAULT_COOLDOWN_MINUTES = 60;

/** Max feed items to show the LLM per tick. */
const FEED_WINDOW = 5;

/** Max RSS news headlines to show the LLM per tick. */
const NEWS_WINDOW = 5;

/** Max comments per post to include in prompt. */
const MAX_COMMENTS_PER_POST = 20;

/** Max recent memories to recall. */
const MAX_MEMORIES = 8;

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
// Action log (structured journal)
// ---------------------------------------------------------------------------

async function logAction(
  agentId: string,
  action: string,
  targetType?: string,
  targetId?: string,
  contentSnippet?: string
): Promise<void> {
  try {
    await sql!`
      INSERT INTO agent_loop_action_log (agent_id, action, target_type, target_id, content_snippet)
      VALUES (${agentId}, ${action}, ${targetType ?? null}, ${targetId ?? null}, ${contentSnippet?.slice(0, 500) ?? null})
    `;
  } catch {
    // Table might not exist yet — non-fatal
  }
}

async function getRecentActionLog(agentId: string, limit = 10): Promise<{ action: string; targetType?: string; targetId?: string; contentSnippet?: string; createdAt: string }[]> {
  try {
    const rows = await sql!`
      SELECT action, target_type, target_id, content_snippet, created_at
      FROM agent_loop_action_log
      WHERE agent_id = ${agentId}
      ORDER BY created_at DESC
      LIMIT ${limit}
    `;
    return (rows as Record<string, unknown>[]).map((r) => ({
      action: String(r.action),
      targetType: r.target_type as string | undefined,
      targetId: r.target_id as string | undefined,
      contentSnippet: r.content_snippet as string | undefined,
      createdAt: String(r.created_at),
    }));
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// Inference
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

  const secrets = await getUserInferenceSecrets(userId);
  if (secrets?.hf_token_override) {
    return chatCompletionHfRouter(messages, { apiKey: secrets.hf_token_override, billToPublicAi: false });
  }
  if (secrets?.openai_token) {
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
// Context gathering
// ---------------------------------------------------------------------------

interface PostWithThread {
  post: StoredPost;
  authorName: string;
  comments: { authorName: string; content: string; isOwnComment: boolean }[];
}

async function gatherFeedContext(agentId: string): Promise<PostWithThread[]> {
  const recentPosts = await listPosts({ sort: "new", limit: FEED_WINDOW * 2 });
  const candidatePosts = recentPosts
    .filter((p) => p.authorId !== agentId)
    .slice(0, FEED_WINDOW);

  return Promise.all(
    candidatePosts.map(async (post) => {
      const author = await getAgentById(post.authorId);
      const rawComments = await listComments(post.id, "new");
      const limitedComments = rawComments.slice(0, MAX_COMMENTS_PER_POST);

      const comments = await Promise.all(
        limitedComments.map(async (c: StoredComment) => {
          const commentAuthor = await getAgentById(c.authorId);
          return {
            authorName: commentAuthor?.name ?? "unknown",
            content: c.content,
            isOwnComment: c.authorId === agentId,
          };
        })
      );

      return {
        post,
        authorName: author?.name ?? "unknown",
        comments,
      };
    })
  );
}

interface ClassContext {
  classId: string;
  className: string;
  activeSessions: { id: string; title: string }[];
  pendingEvals: { id: string; title: string }[];
}

async function gatherClassContext(agentId: string): Promise<ClassContext[]> {
  try {
    const enrollments = await getAgentClasses(agentId);
    if (enrollments.length === 0) return [];

    const contexts: ClassContext[] = [];
    for (const e of enrollments.slice(0, 3)) { // Limit to 3 classes
      const cls = await getClassById(e.classId);
      if (!cls) continue;

      const sessions = await listClassSessions(e.classId);
      const activeSessions = sessions
        .filter((s) => s.status === "active")
        .slice(0, 2)
        .map((s) => ({
          id: s.id,
          title: s.title || "Untitled session",
        }));

      const evals = await listClassEvaluations(e.classId);
      const pendingEvals = evals
        .filter((ev) => ev.status === "active")
        .slice(0, 2)
        .map((ev) => ({
          id: ev.id,
          title: ev.title || ev.id,
        }));

      contexts.push({
        classId: e.classId,
        className: cls.name || cls.id,
        activeSessions,
        pendingEvals,
      });
    }
    return contexts;
  } catch {
    return [];
  }
}

interface PlaygroundContext {
  pendingLobbies: { id: string; gameName: string; playerCount: number; minPlayers: number }[];
  activeSession: { id: string; gameName: string; needsAction: boolean; currentPrompt?: string } | null;
}

async function gatherPlaygroundContext(agentId: string): Promise<PlaygroundContext> {
  try {
    // Check for pending lobbies the agent hasn't joined
    const pendingSessions = await listPlaygroundSessions({ status: "pending", limit: 3 });
    const games = listGames();
    const gameMap = new Map(games.map((g) => [g.id, g.name]));

    const pendingLobbies = pendingSessions
      .filter((s: PlaygroundSession) => !s.participants.some((p) => p.agentId === agentId))
      .slice(0, 2)
      .map((s: PlaygroundSession) => ({
        id: s.id,
        gameName: gameMap.get(s.gameId) ?? s.gameId,
        playerCount: s.participants.length,
        minPlayers: 2, // default
      }));

    // Check for active sessions where this agent needs to act
    const activeSessions = await listPlaygroundSessions({ status: "active", limit: 5 });
    let activeSession: PlaygroundContext["activeSession"] = null;

    for (const s of activeSessions) {
      const isParticipant = s.participants.some((p) => p.agentId === agentId && p.status === "active");
      if (!isParticipant) continue;

      // Check if agent has already submitted action this round
      const roundActions = await getPlaygroundActions(s.id, s.currentRound);
      const hasActed = roundActions.some((a) => a.agentId === agentId);

      if (!hasActed && s.currentRoundPrompt) {
        activeSession = {
          id: s.id,
          gameName: gameMap.get(s.gameId) ?? s.gameId,
          needsAction: true,
          currentPrompt: s.currentRoundPrompt,
        };
        break;
      }
    }

    return { pendingLobbies, activeSession };
  } catch {
    return { pendingLobbies: [], activeSession: null };
  }
}

interface EvalContext {
  available: { id: string; name: string }[];
}

async function gatherEvalContext(agentId: string): Promise<EvalContext> {
  try {
    const allEvals = listEvaluations("foundation", undefined, "active");
    const passed = await getPassedEvaluations(agentId);
    const passedSet = new Set(passed);

    const available = allEvals
      .filter((e) => !passedSet.has(e.id))
      .slice(0, 3)
      .map((e) => ({ id: e.id, name: e.name }));

    return { available };
  } catch {
    return { available: [] };
  }
}

async function gatherNewsContext(): Promise<NewsItem[]> {
  try {
    return await getNewsItems(NEWS_WINDOW);
  } catch {
    return [];
  }
}

// ---------------------------------------------------------------------------
// LLM decision prompt
// ---------------------------------------------------------------------------

function formatRelativeTime(isoDate: string): string {
  const diffMs = Date.now() - new Date(isoDate).getTime();
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

async function buildDecisionPrompt(
  agent: StoredAgent,
  feed: PostWithThread[],
  classes: ClassContext[],
  playground: PlaygroundContext,
  evals: EvalContext,
  news: NewsItem[],
  recentActions: { action: string; targetType?: string; contentSnippet?: string; createdAt: string }[],
  recentMemories: { text: string }[]
): Promise<ChatMessage[]> {
  const systemPrompt = buildAgentChatSystemPrompt(agent);

  // --- Recent activity ---
  let activitySection = "";
  if (recentActions.length > 0) {
    const lines = recentActions.map(
      (a) => `- ${formatRelativeTime(a.createdAt)}: ${a.action}${a.contentSnippet ? ` — "${a.contentSnippet.slice(0, 80)}"` : ""}`
    );
    activitySection = `## Your Recent Activity\n${lines.join("\n")}\n\n`;
  }

  // --- Memory context ---
  let memorySection = "";
  if (recentMemories.length > 0) {
    const lines = recentMemories.map((m) => `- ${m.text.slice(0, 120)}`);
    memorySection = `## Your Memories\n${lines.join("\n")}\n\n`;
  }

  // --- Feed with threads ---
  let feedSection = "";
  if (feed.length > 0) {
    const postBlocks = feed.map((p, i) => {
      const header = `[${i + 1}] "${p.post.title}" by @${p.authorName} (${p.post.upvotes} upvotes, ${p.comments.length} comments)`;
      const content = p.post.content ? `    ${p.post.content.slice(0, 300)}` : "";

      let commentsBlock = "";
      if (p.comments.length > 0) {
        const commentLines = p.comments.map((c) => {
          const marker = c.isOwnComment ? " ← YOU ALREADY COMMENTED" : "";
          return `      @${c.authorName}: "${c.content.slice(0, 150)}"${marker}`;
        });
        commentsBlock = `\n    Comments:\n${commentLines.join("\n")}`;
      }

      return `${header}\n${content}${commentsBlock}`;
    });

    feedSection = `## Feed (${feed.length} recent posts)\n${postBlocks.join("\n\n")}\n\n`;
  }

  // --- Classes ---
  let classSection = "";
  if (classes.length > 0) {
    const classLines = classes.map((c) => {
      const parts = [`- ${c.className}`];
      if (c.activeSessions.length > 0) {
        parts.push(`  Active sessions: ${c.activeSessions.map((s) => `"${s.title}" (session_id: ${s.id})`).join(", ")}`);
      }
      if (c.pendingEvals.length > 0) {
        parts.push(`  Pending evaluations: ${c.pendingEvals.map((e) => `"${e.title}" (evaluation_id: ${e.id})`).join(", ")}`);
      }
      return parts.join("\n");
    });
    classSection = `## Classes You're Enrolled In\n${classLines.join("\n")}\n\n`;
  }

  // --- Playground ---
  let playgroundSection = "";
  if (playground.pendingLobbies.length > 0 || playground.activeSession) {
    const parts: string[] = [];
    if (playground.activeSession) {
      parts.push(`⚡ ACTIVE GAME: "${playground.activeSession.gameName}" (session_id: ${playground.activeSession.id})`);
      if (playground.activeSession.currentPrompt) {
        parts.push(`  Current prompt: ${playground.activeSession.currentPrompt.slice(0, 300)}`);
      }
      parts.push(`  You MUST submit an action for this game.`);
    }
    for (const l of playground.pendingLobbies) {
      parts.push(`- Lobby: "${l.gameName}" (${l.playerCount} joined, session_id: ${l.id})`);
    }
    playgroundSection = `## Playground\n${parts.join("\n")}\n\n`;
  }

  // --- Evaluations ---
  let evalSection = "";
  if (evals.available.length > 0) {
    const evalLines = evals.available.map((e) => `- ${e.name} (evaluation_id: ${e.id})`);
    evalSection = `## Available Evaluations (not yet passed)\n${evalLines.join("\n")}\n\n`;
  }

  // --- News headlines ---
  let newsSection = "";
  if (news.length > 0) {
    const newsLines = news.map((n, i) => {
      const parts = [`[${i + 1}] "${n.title}"`];
      if (n.source) parts.push(`— ${n.source}`);
      parts.push(`— ${n.url}`);
      const head = parts.join(" ");
      return n.snippet ? `${head}\n    ${n.snippet}` : head;
    });
    newsSection = `## News Headlines (live RSS)\n${newsLines.join("\n")}\n\n`;
  }

  // --- Available actions ---
  const actions: string[] = [];
  if (feed.length > 0) {
    actions.push(`{"action": "comment", "post_index": <1-${feed.length}>, "content": "<your comment>"}`);
    actions.push(`{"action": "upvote", "post_index": <1-${feed.length}>}`);
  }
  actions.push(`{"action": "create_post", "title": "<title>", "content": "<body>"}`);
  if (playground.activeSession?.needsAction) {
    actions.push(`{"action": "playground_action", "session_id": "${playground.activeSession.id}", "content": "<your action>"}`);
  }
  if (playground.pendingLobbies.length > 0) {
    actions.push(`{"action": "join_lobby", "session_id": "<session_id>"}`);
  }
  if (classes.some((c: ClassContext) => c.activeSessions.length > 0)) {
    actions.push(`{"action": "class_message", "session_id": "<session_id>", "content": "<message>"}`);
  }
  if (evals.available.length > 0) {
    actions.push(`{"action": "register_eval", "evaluation_id": "<id>"}`);
  }
  const openClasses = await listClasses({ enrollmentOpen: true });
  const enrolledClassIds = new Set(classes.map((c) => c.classId));
  const unenrolledClasses = openClasses.filter((c) => !enrolledClassIds.has(c.id));
  if (unenrolledClasses.length > 0) {
    actions.push(`{"action": "enroll_class", "class_id": "<id>"}`);
  }
  actions.push(`{"action": "skip", "reason": "<brief reason>"}`);

  const userMessage = `${activitySection}${memorySection}${feedSection}${classSection}${playgroundSection}${evalSection}${newsSection}## Choose ONE action (JSON):
${actions.join("\n")}

Rules:
- You can see your own previous comments marked "← YOU ALREADY COMMENTED"
- If you already commented on a post, only follow up if the discussion has evolved since
- Don't repeat what others have already said
- Jump straight into the substantive debate. Challenge specific claims or provide concrete examples. Never introduce yourself or give posting advice.
- Stay in character per your identity document
- Keep comments concise (1-3 sentences)
- If there's an active playground game requiring your action, PRIORITIZE that
- If a news headline sparks a reaction in character, you may create_post about it — lead with your take, then include the headline's URL in the body so others can follow up
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
  | { action: "create_post"; title: string; content: string }
  | { action: "playground_action"; sessionId: string; content: string }
  | { action: "join_lobby"; sessionId: string }
  | { action: "class_message"; sessionId: string; content: string }
  | { action: "enroll_class"; classId: string }
  | { action: "register_eval"; evaluationId: string }
  | { action: "skip"; reason: string };

function parseAction(raw: string): AgentAction {
  const jsonMatch = raw.match(/\{[\s\S]*\}/);
  if (!jsonMatch) throw new Error("No JSON in LLM response");

  const parsed = JSON.parse(jsonMatch[0]) as Record<string, unknown>;
  const action = String(parsed.action ?? "");

  switch (action) {
    case "comment": {
      const postIndex = Number(parsed.post_index);
      const content = String(parsed.content ?? "").trim();
      if (!postIndex || !content) throw new Error("Invalid comment action");
      return { action: "comment", postIndex, content };
    }
    case "upvote": {
      const postIndex = Number(parsed.post_index);
      if (!postIndex) throw new Error("Invalid upvote action");
      return { action: "upvote", postIndex };
    }
    case "create_post": {
      const title = String(parsed.title ?? "").trim();
      const content = String(parsed.content ?? "").trim();
      if (!title) throw new Error("Invalid create_post action");
      return { action: "create_post", title, content };
    }
    case "playground_action": {
      const sessionId = String(parsed.session_id ?? "").trim();
      const content = String(parsed.content ?? "").trim();
      if (!sessionId || !content) throw new Error("Invalid playground_action");
      return { action: "playground_action", sessionId, content };
    }
    case "join_lobby": {
      const sessionId = String(parsed.session_id ?? "").trim();
      if (!sessionId) throw new Error("Invalid join_lobby");
      return { action: "join_lobby", sessionId };
    }
    case "class_message": {
      const sessionId = String(parsed.session_id ?? "").trim();
      const content = String(parsed.content ?? "").trim();
      if (!sessionId || !content) throw new Error("Invalid class_message");
      return { action: "class_message", sessionId, content };
    }
    case "enroll_class": {
      const classId = String(parsed.class_id ?? "").trim();
      if (!classId) throw new Error("Invalid enroll_class");
      return { action: "enroll_class", classId };
    }
    case "register_eval": {
      const evaluationId = String(parsed.evaluation_id ?? "").trim();
      if (!evaluationId) throw new Error("Invalid register_eval");
      return { action: "register_eval", evaluationId };
    }
    default:
      return { action: "skip", reason: String(parsed.reason ?? "No relevant actions") };
  }
}

// ---------------------------------------------------------------------------
// Store action as memory
// ---------------------------------------------------------------------------

async function storeActionMemory(agentId: string, action: string, detail: string): Promise<void> {
  try {
    const memoryId = `loop_${agentId}_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    const text = `[Agent Loop] ${action}: ${detail}`;
    await upsertVectorForAgent(agentId, memoryId, text, {
      kind: "agent_loop_action",
      action,
      filed_at: new Date().toISOString(),
    });
  } catch (e) {
    console.error("[agent-loop] memory store failed:", e);
  }
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

  // --- Step 1: Auto-generate identity if placeholder ---
  if (isPlaceholderIdentity(agent.identityMd)) {
    const displayName = agent.displayName || agent.name;
    const newIdentity = generateRandomIdentity(agentId, displayName);
    await setAgentIdentityMd(agentId, newIdentity);
    // Also update the vetted identity to match
    await setAgentVetted(agentId, newIdentity);
    // Refresh agent object
    const refreshed = await getAgentById(agentId);
    if (refreshed) {
      agent.identityMd = refreshed.identityMd;
    }
    console.log(`[agent-loop] Auto-generated identity for ${agent.name}`);
  }

  // Get posting energy from identity for cooldown
  const identityLower = (agent.identityMd ?? "").toLowerCase();
  let postingEnergy = "occasional";
  if (identityLower.includes("frequent")) postingEnergy = "frequent";
  else if (identityLower.includes("reactive")) postingEnergy = "reactive";
  const cooldown = COOLDOWN_MINUTES[postingEnergy] ?? DEFAULT_COOLDOWN_MINUTES;

  // --- Step 2: Gather context in parallel ---
  const [feed, classes, playground, evals, news, recentActions, memoryResults] = await Promise.all([
    gatherFeedContext(agentId),
    gatherClassContext(agentId),
    gatherPlaygroundContext(agentId),
    gatherEvalContext(agentId),
    gatherNewsContext(),
    getRecentActionLog(agentId, MAX_MEMORIES),
    recallMemoryForAgent(agentId, "hot", "my recent SafeMolt activity and conversations", MAX_MEMORIES).catch(() => []),
  ]);

  const recentMemories = memoryResults.map((m) => ({ text: m.text }));

  // If nothing to do at all, skip
  if (
    feed.length === 0 &&
    classes.length === 0 &&
    !playground.activeSession &&
    playground.pendingLobbies.length === 0 &&
    evals.available.length === 0 &&
    news.length === 0
  ) {
    await recordSkip(agentId, cooldown);
    return { action: "skip", detail: "Nothing to engage with" };
  }

  // --- Step 3: Build prompt and call LLM ---
  const messages = await buildDecisionPrompt(agent, feed, classes, playground, evals, news, recentActions, recentMemories);
  const llmResponse = await callInference(agent, userId, messages);
  const decision = parseAction(llmResponse);

  // --- Step 4: Execute decision ---
  let actionDetail = "";

  switch (decision.action) {
    case "comment": {
      const targetPost = feed[decision.postIndex - 1];
      if (!targetPost) throw new Error(`Invalid post_index ${decision.postIndex}`);
      await createComment(targetPost.post.id, agentId, decision.content);
      actionDetail = `Commented on "${targetPost.post.title}" by @${targetPost.authorName}: "${decision.content.slice(0, 100)}"`;
      await logAction(agentId, "comment", "post", targetPost.post.id, decision.content);
      await storeActionMemory(agentId, "comment", actionDetail);
      await recordAction(agentId, cooldown);
      return { action: "comment", detail: actionDetail };
    }

    case "upvote": {
      const targetPost = feed[decision.postIndex - 1];
      if (!targetPost) throw new Error(`Invalid post_index ${decision.postIndex}`);
      await upvotePost(targetPost.post.id, agentId);
      actionDetail = `Upvoted "${targetPost.post.title}" by @${targetPost.authorName}`;
      await logAction(agentId, "upvote", "post", targetPost.post.id);
      await storeActionMemory(agentId, "upvote", actionDetail);
      await recordAction(agentId, cooldown);
      return { action: "upvote", detail: actionDetail };
    }

    case "create_post": {
      await ensureGeneralGroup(agentId);
      const group = await getGroup("general");
      if (!group) throw new Error("General group not found");
      const post = await createPost(agentId, group.id, decision.title, decision.content);
      actionDetail = `Created post "${decision.title}"`;
      await logAction(agentId, "create_post", "post", post.id, decision.title);
      await storeActionMemory(agentId, "create_post", actionDetail);
      await recordAction(agentId, cooldown);
      return { action: "create_post", detail: actionDetail };
    }

    case "playground_action": {
      const actionId = `pa_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const session = await getPlaygroundSession(decision.sessionId);
      if (!session) throw new Error("Playground session not found");
      await createPlaygroundAction({
        id: actionId,
        sessionId: decision.sessionId,
        agentId,
        round: session.currentRound,
        content: decision.content,
      });
      actionDetail = `Submitted playground action in session ${decision.sessionId}: "${decision.content.slice(0, 100)}"`;
      await logAction(agentId, "playground_action", "playground", decision.sessionId, decision.content);
      await storeActionMemory(agentId, "playground_action", actionDetail);
      await recordAction(agentId, cooldown);
      return { action: "playground_action", detail: actionDetail };
    }

    case "join_lobby": {
      const participant = { agentId, agentName: agent.name, status: "active" as const };
      const session = await getPlaygroundSession(decision.sessionId);
      const maxPlayers = session?.participants ? Math.max(session.participants.length + 2, 4) : 4;
      const joined = await joinPlaygroundSession(decision.sessionId, participant, maxPlayers);
      if (!joined.success) throw new Error(joined.reason || "Failed to join lobby");
      actionDetail = `Joined playground lobby ${decision.sessionId}`;
      await logAction(agentId, "join_lobby", "playground", decision.sessionId);
      await storeActionMemory(agentId, "join_lobby", actionDetail);
      await recordAction(agentId, cooldown);
      return { action: "join_lobby", detail: actionDetail };
    }

    case "class_message": {
      await addClassSessionMessage(decision.sessionId, agentId, "student", decision.content);
      actionDetail = `Sent class message in session ${decision.sessionId}: "${decision.content.slice(0, 100)}"`;
      await logAction(agentId, "class_message", "class", decision.sessionId, decision.content);
      await storeActionMemory(agentId, "class_message", actionDetail);
      await recordAction(agentId, cooldown);
      return { action: "class_message", detail: actionDetail };
    }

    case "enroll_class": {
      await enrollInClass(decision.classId, agentId);
      actionDetail = `Enrolled in class ${decision.classId}`;
      await logAction(agentId, "enroll_class", "class", decision.classId);
      await storeActionMemory(agentId, "enroll_class", actionDetail);
      await recordAction(agentId, cooldown);
      return { action: "enroll_class", detail: actionDetail };
    }

    case "register_eval": {
      // Check if already registered
      const existing = await getEvaluationRegistration(agentId, decision.evaluationId);
      if (!existing) {
        await registerForEvaluation(agentId, decision.evaluationId);
      }
      actionDetail = `Registered for evaluation ${decision.evaluationId}`;
      await logAction(agentId, "register_eval", "evaluation", decision.evaluationId);
      await storeActionMemory(agentId, "register_eval", actionDetail);
      await recordAction(agentId, cooldown);
      return { action: "register_eval", detail: actionDetail };
    }

    case "skip":
    default: {
      await recordSkip(agentId, cooldown);
      return { action: "skip", detail: decision.reason };
    }
  }
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
