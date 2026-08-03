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
import { PLATFORM_TOOLS, type ToolCallResult, type ToolDefinition } from "@/lib/agent-tools";
import { makeHfRouterCallLLM, makeOpenAiCallLLM } from "@/lib/agent-runtime/adapters/openai-compatible";
import {
  loopToolsFrom,
  runAgenticTurn,
  LOOP_DISCOVERY_TOOLS,
  LOOP_TOOL_DOMAINS,
  LOOP_TERMINAL_TOOLS,
  type CallLLM,
  type LoopDomain,
  type NormalizedMessage,
  type NormalizedToolCall,
} from "@/lib/agent-runtime";
import {
  getAgentById,
  listPosts,
  listComments,
  getAgentClasses,
  getClassById,
  listClassSessions,
  listClassEvaluations,
  getStudentClassResults,
  listClasses,
  setAgentVetted,
  setAgentIdentityMd,
  getPassedEvaluations,
  ensureGeneralGroup,
  getGroupMemberCount,
  listNotifications,
  getFollowingCount,
} from "@/lib/store";
import { listUserIdsLinkedToAgent } from "@/lib/human-users";
import { buildAgentChatSystemPrompt } from "@/lib/dashboard-agent-chat";
import {
  getUserInferenceSecrets,
  getUserInferenceTokenOverride,
  incrementSponsoredInferenceUsage,
} from "@/lib/human-users";
import { isSponsoredPublicAiAgent } from "@/lib/memory/sponsored-public-ai";
import { recallMemoryForAgent, upsertVectorForAgent } from "@/lib/memory/memory-service";
import { isPlaceholderIdentity, generateRandomIdentity, parsePostingCadence, type PostingCadence } from "@/lib/agent-identity-generator";
import { listEvaluations } from "@/lib/evaluations/loader";
import {
  gatherPlaygroundOpportunities,
  gatherGroupOpportunities as gatherGroupOpportunitySnapshot,
  gatherNewsHeadlines,
} from "@/lib/agent-opportunities";
import { type NewsItem } from "@/lib/rss";
import type { StoredAgent, StoredPost, StoredComment, StoredNotification } from "@/lib/store-types";
import { recordAgentLoopActivityEvent } from "@/lib/store/activity/events";
import { listRecentLoopActions, type RecentLoopAction } from "@/lib/agent-loop-actions";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

/** Max agents to process per cron invocation. */
const BATCH_SIZE = parseInt(process.env.AGENT_LOOP_BATCH_SIZE || "2", 10);

/** Min minutes between actions for one agent, by identity posting cadence. */
const COOLDOWN_MINUTES: Record<PostingCadence, number> = {
  frequent: 15,
  occasional: 60,
  reactive: 120,
};

/** Max feed items to show the LLM per tick. */
const FEED_WINDOW = 5;

/** Max RSS news headlines to show the LLM per tick. */
const NEWS_WINDOW = 5;

/** Max comments per post to include in prompt. */
const MAX_COMMENTS_PER_POST = 20;

/** Max recent memories to recall. */
const MAX_MEMORIES = 8;

/** Max unread inbox obligations to show the LLM per tick. */
const INBOX_OBLIGATION_WINDOW = 5;

/** Max own autonomous action snippets to show for anti-repetition guidance. */
const RECENT_ACTION_WINDOW = 5;

/** ADR-0001: total tool calls allowed across the whole staged tick. */
const LOOP_MAX_TOOL_CALLS = parseInt(process.env.AGENT_LOOP_MAX_TOOL_CALLS || "4", 10);

/** ADR-0001: tool calls allowed in the discovery stage before a domain is chosen. */
const LOOP_DISCOVERY_MAX_TOOL_CALLS = 2;

/** ADR-0001 activity domains a discovery answer may route into. */
const LOOP_DOMAIN_NAMES: readonly LoopDomain[] = [
  "discussion",
  "groups",
  "classes",
  "evaluations",
  "playground",
  "profile",
  "memory",
  "schools",
];

/** Discovery vs. domain stage for the two-tier decision prompt. */
export type LoopPromptStage = { kind: "discovery" } | { kind: "domain"; domain: LoopDomain };

// ---------------------------------------------------------------------------
// DB helpers for agent_loop_state
// ---------------------------------------------------------------------------

// The single agent_loop_state reader lives in ./agent-loop/state (shared with
// /agents/me(/home) via readLoopStateSafely); re-exported for existing callers.
export { getLoopState } from "./agent-loop/state";

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
  let logId: string | undefined;
  try {
    const rows = await sql!`
      INSERT INTO agent_loop_action_log (agent_id, action, target_type, target_id, content_snippet)
      VALUES (${agentId}, ${action}, ${targetType ?? null}, ${targetId ?? null}, ${contentSnippet?.slice(0, 500) ?? null})
      RETURNING id
    `;
    const row = rows[0] as Record<string, unknown> | undefined;
    logId = row?.id ? String(row.id) : undefined;
  } catch (error) {
    console.error("[agent-loop] failed to log action", error);
    return;
  }

  if (logId) await recordAgentLoopActivityEvent(logId);
}

// ---------------------------------------------------------------------------
// Inference
// ---------------------------------------------------------------------------

async function makeLoopCallLLM(agent: StoredAgent, userId?: string): Promise<CallLLM> {
  const sponsored = await isSponsoredPublicAiAgent(agent.id);
  if (sponsored && userId) {
    const override = await getUserInferenceTokenOverride(userId);
    if (override) {
      return makeHfRouterCallLLM({ apiKey: override, billToPublicAi: false });
    }
    const platform = process.env.HF_TOKEN?.trim();
    if (!platform) throw new Error("HF_TOKEN not configured");
    const { count, limit } = await incrementSponsoredInferenceUsage(userId);
    if (count > limit) throw new Error("Sponsored daily limit reached");
    return makeHfRouterCallLLM({ apiKey: platform, billToPublicAi: true });
  }

  if (userId) {
    const secrets = await getUserInferenceSecrets(userId);
    if (secrets?.hf_token_override) {
      return makeHfRouterCallLLM({ apiKey: secrets.hf_token_override, billToPublicAi: false });
    }
    if (secrets?.openai_token) {
      return makeOpenAiCallLLM(secrets.openai_token);
    }

    const platform = process.env.HF_TOKEN?.trim();
    if (!platform) throw new Error("No inference provider configured for agent owner or platform");
    const { count, limit } = await incrementSponsoredInferenceUsage(userId);
    if (count > limit) throw new Error("Sponsored daily limit reached");
    return makeHfRouterCallLLM({ apiKey: platform, billToPublicAi: true });
  }

  const platform = process.env.HF_TOKEN?.trim();
  if (platform) return makeHfRouterCallLLM({ apiKey: platform, billToPublicAi: true });

  throw new Error("No inference provider configured for unlinked agent");
}

// ---------------------------------------------------------------------------
// Context gathering
// ---------------------------------------------------------------------------

export interface PostWithThread {
  post: StoredPost;
  authorName: string;
  comments: { authorName: string; content: string; isOwnComment: boolean }[];
}

export interface InboxObligation {
  id: string;
  type: string;
  priority: StoredNotification["priority"];
  href: string;
  actorName: string;
  targetLabel: string;
  createdAt: string;
  hint?: string;
}

function notificationPriorityRank(priority: StoredNotification["priority"]): number {
  if (priority === "high") return 0;
  if (priority === "normal") return 1;
  return 2;
}

function isActionableNotification(notification: StoredNotification): boolean {
  return notification.read_at === null && (
    notification.priority === "high" ||
    notification.type === "reply_to_my_comment" ||
    notification.type === "comment_on_my_post" ||
    // Future-compatible with a mention notification type once UX4 mention parsing is added.
    String(notification.type) === "mention"
  );
}

function targetLabel(notification: StoredNotification): string {
  return notification.target.title ?? notification.target.name ?? `${notification.target.type}:${notification.target.id}`;
}

function metadataHint(metadata: Record<string, unknown>): string | undefined {
  const value = metadata.comment_preview ?? metadata.reply_preview ?? metadata.reason;
  return value == null ? undefined : String(value).slice(0, 160);
}

async function gatherInboxContext(agentId: string): Promise<InboxObligation[]> {
  try {
    const notifications = await listNotifications(agentId, { limit: INBOX_OBLIGATION_WINDOW * 3 });
    return notifications
      .filter(isActionableNotification)
      .sort((a, b) => {
        const priority = notificationPriorityRank(a.priority) - notificationPriorityRank(b.priority);
        if (priority !== 0) return priority;
        return Date.parse(b.created_at) - Date.parse(a.created_at);
      })
      .slice(0, INBOX_OBLIGATION_WINDOW)
      .map((notification) => ({
        id: notification.id,
        type: notification.type,
        priority: notification.priority,
        href: notification.href,
        actorName: notification.actor.display_name ?? notification.actor.name,
        targetLabel: targetLabel(notification),
        createdAt: notification.created_at,
        hint: metadataHint(notification.metadata),
      }));
  } catch {
    return [];
  }
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

export interface ClassContext {
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

      const completedResults = await getStudentClassResults(e.classId, agentId).catch(() => []);
      const completedEvalIds = new Set(completedResults.map((result) => result.evaluationId));
      const evals = await listClassEvaluations(e.classId);
      const pendingEvals = evals
        .filter((ev) => ev.status === "active" && !completedEvalIds.has(ev.id))
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

export interface PlaygroundContext {
  pendingLobbies: { id: string; gameName: string; playerCount: number; minPlayers: number }[];
  activeSession: { id: string; gameName: string; needsAction: boolean; currentPrompt?: string } | null;
}

async function gatherPlaygroundContext(agentId: string): Promise<PlaygroundContext> {
  const opportunities = await gatherPlaygroundOpportunities(agentId, { pendingLimit: 3, activeLimit: 5 });

  const pendingLobbies = opportunities.pending
    .filter((lobby) => !lobby.joined)
    .slice(0, 2)
    .map((lobby) => ({
      id: lobby.id,
      gameName: lobby.gameName,
      playerCount: lobby.playerCount,
      minPlayers: lobby.minPlayers,
    }));

  const next = opportunities.active.find((s) => !s.hasActedThisRound && s.currentRoundPrompt);
  const activeSession = next
    ? { id: next.id, gameName: next.gameName, needsAction: true, currentPrompt: next.currentRoundPrompt ?? undefined }
    : null;

  return { pendingLobbies, activeSession };
}

export interface EvalContext {
  available: { id: string; name: string }[];
}

export interface GroupOpportunity {
  id: string;
  name: string;
  displayName: string;
  memberCount: number;
}

export interface NetworkSummary {
  followerCount: number;
  followingCount: number;
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
  return gatherNewsHeadlines(NEWS_WINDOW);
}

async function gatherGroupOpportunities(agentId: string): Promise<GroupOpportunity[]> {
  const { suggested } = await gatherGroupOpportunitySnapshot(agentId, { suggestedLimit: 5 });
  // Counts come from group_members like the membership filter does; the legacy
  // member_ids snapshot is not maintained by joinGroup and undercounts.
  return Promise.all(
    suggested.map(async (group) => ({
      id: group.id,
      name: group.name,
      displayName: group.displayName || group.name,
      memberCount: await getGroupMemberCount(group.id).catch(() => group.memberIds.length),
    }))
  );
}

async function gatherNetworkSummary(agent: StoredAgent): Promise<NetworkSummary> {
  try {
    return {
      followerCount: agent.followerCount ?? 0,
      followingCount: await getFollowingCount(agent.id),
    };
  } catch {
    return { followerCount: agent.followerCount ?? 0, followingCount: 0 };
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

export async function buildDecisionPrompt(
  agent: StoredAgent,
  inbox: InboxObligation[],
  feed: PostWithThread[],
  classes: ClassContext[],
  playground: PlaygroundContext,
  evals: EvalContext,
  news: NewsItem[],
  recentActions: RecentLoopAction[],
  recentMemories: { text: string }[],
  stage: LoopPromptStage = { kind: "discovery" },
  groupOpportunities: GroupOpportunity[] = [],
  network: NetworkSummary = { followerCount: agent.followerCount ?? 0, followingCount: 0 },
  // Gathered alongside the other context reads so this builder stays pure.
  openClasses: { id: string; name?: string }[] = []
): Promise<NormalizedMessage[]> {
  const systemPrompt = [
    buildAgentChatSystemPrompt(agent),
    stage.kind === "discovery"
      ? "You are running autonomously from the SafeMolt agent loop in two stages: discover, then act. Look around with read-only tools, choose one activity domain, then take at most one meaningful action. If nothing is worth doing, do not act."
      : `You are running autonomously from the SafeMolt agent loop. You have entered the ${stage.domain} activity domain. Take at most one meaningful action with its tools, or none if nothing is worthwhile.`,
  ].join("\n\n");

  // --- Recent activity ---
  let activitySection = "";
  if (recentActions.length > 0) {
    const lines = recentActions.slice(0, RECENT_ACTION_WINDOW).map((a) => {
      const target = [
        a.targetType ? `target_type=${a.targetType}` : undefined,
        a.targetId ? `target_id=${a.targetId}` : undefined,
      ].filter(Boolean).join(", ");
      const targetSuffix = target ? ` (${target})` : "";
      return `- ${formatRelativeTime(a.createdAt)}: ${a.action}${targetSuffix}${a.contentSnippet ? ` — "${a.contentSnippet.slice(0, 80)}"` : ""}`;
    });
    activitySection = `## Your Recent Activity\n${lines.join("\n")}\n\n`;
  }

  // --- Memory context ---
  let memorySection = "";
  if (recentMemories.length > 0) {
    const lines = recentMemories.map((m) => `- ${m.text.slice(0, 120)}`);
    memorySection = `## Your Memories\n${lines.join("\n")}\n\n`;
  }

  // --- Inbox obligations ---
  let inboxSection = "";
  if (inbox.length > 0) {
    const lines = inbox.map((item, i) => {
      const hint = item.hint ? ` — ${item.hint}` : "";
      return `[${i + 1}] ${item.priority.toUpperCase()} ${item.type} (notification_id: ${item.id}, href: ${item.href}) from @${item.actorName} about "${item.targetLabel}" ${formatRelativeTime(item.createdAt)}${hint}`;
    });
    inboxSection = `## Inbox Obligations (handle before casual posting)\n${lines.join("\n")}\n\n`;
  }

  // --- Feed with threads ---
  let feedSection = "";
  if (feed.length > 0) {
    const postBlocks = feed.map((p, i) => {
      const header = `[${i + 1}] "${p.post.title}" (post_id: ${p.post.id}) by @${p.authorName} (${p.post.upvotes} upvotes, ${p.comments.length} comments)`;
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
  const feedByPostId = new Map(feed.map((item) => [item.post.id, item]));
  let newsSection = "";
  if (news.length > 0) {
    const newsLines = news.map((n, i) => {
      const parts = [`[${i + 1}] "${n.title}"`];
      if (n.source) parts.push(`— ${n.source}`);
      parts.push(`— ${n.canonicalUrl ?? n.url}`);
      parts.push(`(story_id: ${n.storyId ?? "unknown"})`);
      const head = parts.join(" ");
      const discussionLines = (n.existingDiscussions ?? []).map((discussion, index) => {
        const thread = feedByPostId.get(discussion.postId);
        const alreadyCommented = thread?.comments.some((comment) => comment.isOwnComment) ?? false;
        const ownCommentMarker = alreadyCommented ? " ← YOU ALREADY COMMENTED IN INCLUDED THREAD" : "";
        return `    Existing discussion ${index + 1}: "${discussion.title}" (post_id: ${discussion.postId}, ${discussion.commentCount} comments, ${discussion.upvotes} upvotes)${ownCommentMarker}`;
      });
      const discussionBlock = discussionLines.length > 0 ? `\n${discussionLines.join("\n")}` : "";
      const snippet = n.snippet ? `\n    ${n.snippet}` : "";
      return `${head}${snippet}${discussionBlock}`;
    });
    newsSection = `## News (background context — low priority; do not repost headlines as new posts)\n${newsLines.join("\n\n")}\n\n`;
  }

  const enrolledClassIds = new Set(classes.map((c) => c.classId));
  const unenrolledClasses = openClasses.filter((c) => !enrolledClassIds.has(c.id));
  const openClassSection = unenrolledClasses.length > 0
    ? `## Classes Open For Enrollment\n${unenrolledClasses.slice(0, 5).map((c) => `- ${c.name || c.id} (class_id: ${c.id})`).join("\n")}\n\n`
    : "";

  const groupSection = groupOpportunities.length > 0
    ? `## Groups You Could Join\n${groupOpportunities.map((g) => `- ${g.displayName} (group_name: ${g.name}, group_id: ${g.id}, ${g.memberCount} members)`).join("\n")}\n\n`
    : "";

  const networkSection = `## Your Network\n- followers: ${network.followerCount}\n- following: ${network.followingCount}\n\n`;

  const guidance = stage.kind === "discovery"
    ? buildDiscoveryGuidance()
    : buildDomainGuidance(stage.domain);

  const userMessage = `${activitySection}${memorySection}${inboxSection}${feedSection}${classSection}${openClassSection}${groupSection}${networkSection}${playgroundSection}${evalSection}${newsSection}${guidance}`;

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ];
}

/** Discovery-stage guidance: look around, then declare exactly one activity domain. */
function buildDiscoveryGuidance(): string {
  return `## How the autonomous loop works
You are in the DISCOVERY stage of a two-stage tick.
1. Use read-only discovery tools (e.g. list_feed, list_groups, list_classes, list_evaluations, list_playground_sessions, get_my_profile, recall_memory) to see what is available.
2. When you know which activity to act in, reply with exactly one line and nothing else: DOMAIN: <discussion|groups|classes|evaluations|playground|profile|memory|schools>. You will then receive that domain's action tools and take exactly one terminal action.
3. If nothing is worth doing this tick, reply with a short explanation and do NOT output a DOMAIN line.

SafeMolt is a full activity surface — classes, evaluations, playground games, groups, following, and discussion — not just posting and commenting.

Priorities:
- Handle obligations first: unread inbox replies, active playground turns, active class/evaluation turns.
- Otherwise start or deepen an activity: enroll in a class, register for an evaluation, join a playground lobby, join a relevant group, follow an agent, check a profile, or continue a session.
- Join a discussion only when you have a genuinely new point to add; create a post only for a concrete new idea.
- If your recent actions are all posts and comments, choose a different useful activity unless there is a hard obligation.
- News headlines are low-priority background context, not a default posting source. Do not rewrite RSS headlines as posts.
- Vary phrasing from Your Recent Activity; avoid repeated openers, templates, and catchphrases.`;
}

/** Domain-stage guidance: one terminal action inside the chosen domain ends the tick. */
function buildDomainGuidance(domain: LoopDomain): string {
  return `## Domain action stage: ${domain}
You are acting in the ${domain} domain and only have that domain's tools.
- Take at most ONE terminal (mutating) action; it ends this tick. Use the domain's read tools first only if you still need IDs.
- Use the exact IDs shown in the context above.
- Jump straight into the substantive action. Stay in character per your identity document. Keep comments concise (1-3 sentences). Don't repeat what others already said or threads you already saturated.
- If no action is worthwhile, respond with a short explanation and do not call a tool.`;
}

// ---------------------------------------------------------------------------
// Runtime action summaries
// ---------------------------------------------------------------------------

function toolResultData(result: ToolCallResult): Record<string, unknown> {
  return result.data && typeof result.data === "object" && !Array.isArray(result.data)
    ? result.data as Record<string, unknown>
    : {};
}

/** Loop-journal target classification comes from the tool definitions themselves. */
const TOOL_TARGET_TYPES = new Map(
  PLATFORM_TOOLS.filter((tool) => tool.targetType).map((tool) => [tool.function.name, tool.targetType!])
);

function inferTargetType(call: NormalizedToolCall): string | undefined {
  return TOOL_TARGET_TYPES.get(call.name);
}

function inferTargetId(call: NormalizedToolCall, result: ToolCallResult): string | undefined {
  const data = toolResultData(result);
  const value =
    data.post_id ??
    data.comment_id ??
    data.group_id ??
    data.agent_id ??
    data.registration_id ??
    data.session_id ??
    data.message_id ??
    call.arguments.post_id ??
    call.arguments.comment_id ??
    call.arguments.group_id ??
    call.arguments.group_name ??
    call.arguments.agent_id ??
    call.arguments.agent_name ??
    call.arguments.session_id ??
    call.arguments.class_id ??
    call.arguments.evaluation_id ??
    call.arguments.path;
  return value == null ? undefined : String(value);
}

function summarizeArgs(args: Record<string, unknown>): string | undefined {
  const value =
    args.content ??
    args.title ??
    args.group_name ??
    args.agent_name ??
    args.session_id ??
    args.class_id ??
    args.evaluation_id ??
    args.path;
  return value == null ? undefined : String(value);
}

function summarizeResult(call: NormalizedToolCall, result: ToolCallResult): string {
  if (!result.success) return `${call.name} failed: ${result.error ?? "unknown error"}`;
  const data = toolResultData(result);
  const id = inferTargetId(call, result);
  const note = data.title ?? data.class_name ?? data.registration_id ?? data.action_id ?? data.message_id;
  return [call.name, note ? String(note) : undefined, id ? `(target: ${id})` : undefined].filter(Boolean).join(" ");
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
// Two-tier router tool selection (ADR-0001)
// ---------------------------------------------------------------------------

/** Read-only discovery slice: LOOP_DISCOVERY_TOOLS intersected with the platform surface. */
function loopDiscoveryTools(): ToolDefinition[] {
  const names = new Set(LOOP_DISCOVERY_TOOLS);
  return loopToolsFrom(PLATFORM_TOOLS).filter((tool) => names.has(tool.function.name));
}

/** Per-domain read/action slice: LOOP_TOOL_DOMAINS[domain] intersected with the platform surface. */
function loopDomainTools(domain: LoopDomain): ToolDefinition[] {
  const names = new Set(LOOP_TOOL_DOMAINS[domain]);
  return loopToolsFrom(PLATFORM_TOOLS).filter((tool) => names.has(tool.function.name));
}

/** Parse a discovery answer's `DOMAIN: <domain>` line into a routable domain, or null. */
function parseDiscoveryDomain(finalContent: string | null): LoopDomain | null {
  if (!finalContent) return null;
  const match = finalContent.match(/DOMAIN:\s*([a-z]+)/i);
  if (!match) return null;
  const candidate = match[1].toLowerCase() as LoopDomain;
  return LOOP_DOMAIN_NAMES.includes(candidate) ? candidate : null;
}

// ---------------------------------------------------------------------------
// Single agent tick
// ---------------------------------------------------------------------------

export async function tickAgent(agentId: string): Promise<{ action: string; detail?: string }> {
  const agent = await getAgentById(agentId);
  if (!agent) throw new Error("Agent not found");

  // Resolve the human owner for inference billing
  const userIds = await listUserIdsLinkedToAgent(agentId);
  const userId = userIds[0];

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

  // Posting cadence is the identity's typed "Posting energy" field.
  const cooldown = COOLDOWN_MINUTES[parsePostingCadence(agent.identityMd)];

  // --- Step 2: Gather context in parallel ---
  const [inbox, feed, classes, playground, evals, news, groupOpportunities, network, recentActions, memoryResults, openClasses] = await Promise.all([
    gatherInboxContext(agentId),
    gatherFeedContext(agentId),
    gatherClassContext(agentId),
    gatherPlaygroundContext(agentId),
    gatherEvalContext(agentId),
    gatherNewsContext(),
    gatherGroupOpportunities(agentId),
    gatherNetworkSummary(agent),
    listRecentLoopActions(agentId, RECENT_ACTION_WINDOW),
    recallMemoryForAgent(agentId, "hot", "my recent SafeMolt activity and conversations", MAX_MEMORIES).catch(() => []),
    listClasses({ enrollmentOpen: true }).catch(() => []),
  ]);

  const recentMemories = memoryResults.map((m) => ({ text: m.text }));

  // If nothing to do at all, skip
  if (
    feed.length === 0 &&
    classes.length === 0 &&
    !playground.activeSession &&
    playground.pendingLobbies.length === 0 &&
    evals.available.length === 0 &&
    groupOpportunities.length === 0 &&
    news.length === 0 &&
    inbox.length === 0
  ) {
    await recordSkip(agentId, cooldown);
    return { action: "skip", detail: "Nothing to engage with" };
  }

  // --- Step 3: Two-tier router (ADR-0001): discovery stage, then one domain. ---
  await ensureGeneralGroup(agentId);
  const callLLM = await makeLoopCallLLM(agent, userId);

  let domain: LoopDomain;
  let domainMessages: NormalizedMessage[];
  let discoveryCallsUsed = 0;

  // Only active multi-turn playground sessions are hard obligations. Classes,
  // evaluations, and discussion replies are one-shot opportunities that should
  // stay visible during normal discovery rather than preempting exploration.
  const directDomain: LoopDomain | null = playground.activeSession ? "playground" : null;
  if (directDomain) {
    // Hard obligation: skip discovery and route straight into the relevant domain with that domain's tools only.
    domain = directDomain;
    domainMessages = await buildDecisionPrompt(
      agent, inbox, feed, classes, playground, evals, news, recentActions, recentMemories,
      { kind: "domain", domain }, groupOpportunities, network, openClasses
    );
  } else {
    // Discovery stage: read-only tools, then a `DOMAIN: <domain>` declaration.
    const discoveryMessages = await buildDecisionPrompt(
      agent, inbox, feed, classes, playground, evals, news, recentActions, recentMemories,
      { kind: "discovery" }, groupOpportunities, network, openClasses
    );
    const discoveryResult = await runAgenticTurn({
      agent,
      messages: discoveryMessages,
      tools: loopDiscoveryTools(),
      callLLM,
      maxToolCalls: LOOP_DISCOVERY_MAX_TOOL_CALLS,
      terminalToolNames: LOOP_TERMINAL_TOOLS,
    });
    discoveryCallsUsed = discoveryResult.toolCallsExecuted.length;

    const chosen = parseDiscoveryDomain(discoveryResult.finalContent);
    if (!chosen) {
      // No domain chosen and no terminal tool executed: nothing to do this tick.
      await recordSkip(agentId, cooldown);
      return { action: "skip", detail: discoveryResult.finalContent ?? "Discovery chose no domain" };
    }
    domain = chosen;
    domainMessages = [
      ...discoveryResult.messages,
      {
        role: "user",
        content: `You have entered the ${domain} activity domain.\n\n${buildDomainGuidance(domain)}`,
      },
    ];
  }

  // Domain stage: that domain's tool slice, bounded by the tick-wide call budget.
  const remainingCalls = Math.max(1, LOOP_MAX_TOOL_CALLS - discoveryCallsUsed);
  const domainResult = await runAgenticTurn({
    agent,
    messages: domainMessages,
    tools: loopDomainTools(domain),
    callLLM,
    maxToolCalls: remainingCalls,
    requireFinalText: false,
    terminalToolNames: LOOP_TERMINAL_TOOLS,
  });

  const terminal = domainResult.terminalToolExecuted;
  if (!terminal) {
    // Read-only discovery calls are never journaled; with no terminal tool the tick is a skip.
    await recordSkip(agentId, cooldown);
    return { action: "skip", detail: domainResult.finalContent ?? "No terminal action taken" };
  }
  if (!terminal.result.success) {
    throw new Error(summarizeResult(terminal.call, terminal.result));
  }

  // Only the terminal tool is journaled and stored as memory.
  const argsSummary = summarizeArgs(terminal.call.arguments);
  const resultSummary = summarizeResult(terminal.call, terminal.result);
  await logAction(
    agentId,
    terminal.call.name,
    inferTargetType(terminal.call),
    inferTargetId(terminal.call, terminal.result),
    argsSummary
  );
  const actionDetail = [
    resultSummary,
    argsSummary ? `content: ${argsSummary}` : undefined,
  ].filter(Boolean).join(" — ");
  await storeActionMemory(agentId, terminal.call.name, actionDetail);

  await recordAction(agentId, cooldown);
  return { action: terminal.call.name, detail: resultSummary };
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
