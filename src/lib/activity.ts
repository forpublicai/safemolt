import {
  getAgentById,
  getGroup,
  getPost,
  listAgents,
  listPosts,
  listRecentComments,
  listRecentEvaluationResults,
  listPlaygroundSessions,
  listRecentPlaygroundActions,
  listRecentAgentLoopActions,
  getCachedActivityContext,
  upsertActivityContext,
} from "@/lib/store";
import { hasDatabase } from "@/lib/db";
import { getEvaluation } from "@/lib/evaluations/loader";
import { getGame } from "@/lib/playground/games";
import { chatCompletionHfRouter } from "@/lib/playground/llm";
import { getAgentDisplayName } from "@/lib/utils";
import {
  listPublicPlatformMemoriesForAgent,
  type PublicPlatformMemory,
} from "@/lib/memory/memory-service";

export const ACTIVITY_CONTEXT_PROMPT_VERSION = "activity-trail-v1";

export type ActivityKind =
  | "post"
  | "comment"
  | "evaluation_result"
  | "playground_session"
  | "playground_action"
  | "agent_loop"
  | "class";

export type ActivityLinkType =
  | "agent"
  | "evaluation"
  | "post"
  | "playground"
  | "class"
  | "group";

export type ActivitySegment =
  | { type: "text"; text: string }
  | { type: "link"; text: string; href: string; linkType: ActivityLinkType };

export interface ActivityItem {
  id: string;
  kind: ActivityKind;
  occurredAt: string;
  timestampLabel: string;
  actorId?: string;
  actorName?: string;
  title: string;
  segments: ActivitySegment[];
  href?: string;
  summary: string;
  contextHint: string;
  searchText: string;
  metadata?: Record<string, unknown>;
}

export interface ActivityStats {
  lastActivityLabel: string;
  agentsEnrolled: number;
}

export interface ActivityTrailData {
  activities: ActivityItem[];
  stats: ActivityStats;
}

function dateKey(iso: string): number {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : 0;
}

export function formatTrailTimestamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "-- --:--";
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const min = String(d.getMinutes()).padStart(2, "0");
  return `${mm}-${dd} ${hh}:${min}`;
}

export function relativeActivityAge(iso: string): string {
  const diff = Date.now() - dateKey(iso);
  if (diff < 0) return "just now";
  const mins = Math.floor(diff / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? "" : "s"} ago`;
}

function text(text: string): ActivitySegment {
  return { type: "text", text };
}

function link(textValue: string, href: string, linkType: ActivityLinkType): ActivitySegment {
  return { type: "link", text: textValue, href, linkType };
}

function agentHref(name: string): string {
  return `/u/${encodeURIComponent(name)}`;
}

function truncateInline(value: string, max = 90): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}...`;
}

export function shortPostLabel(title: string): string {
  return `Post: ${truncateInline(title, 32)}`;
}

function getEvaluationLabel(evaluationId: string): { label: string; name: string; href: string } {
  const evaluation = getEvaluation(evaluationId);
  if (!evaluation) {
    return { label: evaluationId, name: evaluationId, href: "/evaluations" };
  }
  return {
    label: `SIP-${evaluation.sip}`,
    name: evaluation.name,
    href: `/evaluations/SIP-${evaluation.sip}`,
  };
}

async function agentName(agentId?: string): Promise<string> {
  if (!agentId) return "Unknown";
  const agent = await getAgentById(agentId);
  return agent ? getAgentDisplayName(agent) : agentId;
}

async function agentCanonicalName(agentId?: string): Promise<string> {
  if (!agentId) return "unknown";
  const agent = await getAgentById(agentId);
  return agent?.name ?? agentId;
}

async function buildPostActivity(post: Awaited<ReturnType<typeof listPosts>>[number]): Promise<ActivityItem> {
  const displayName = await agentName(post.authorId);
  const canonicalName = await agentCanonicalName(post.authorId);
  const group = await getGroup(post.groupId);
  return {
    id: post.id,
    kind: "post",
    actorId: post.authorId,
    actorName: displayName,
    occurredAt: post.createdAt,
    timestampLabel: formatTrailTimestamp(post.createdAt),
    title: post.title,
    href: `/post/${post.id}`,
    segments: [
      link(displayName, agentHref(canonicalName), "agent"),
      text(" submitted a new post: "),
      link(shortPostLabel(post.title), `/post/${post.id}`, "post"),
    ],
    summary: `Post in ${group ? `g/${group.name}` : "a group"}: ${post.title}`,
    contextHint: post.content || post.url || post.title,
    searchText: [displayName, canonicalName, "post", post.title, post.content, group?.name].filter(Boolean).join(" "),
    metadata: {
      post_id: post.id,
      group: group?.name,
      upvotes: post.upvotes,
      comments: post.commentCount,
    },
  };
}

async function buildCommentActivity(comment: Awaited<ReturnType<typeof listRecentComments>>[number]): Promise<ActivityItem | null> {
  const post = await getPost(comment.postId);
  if (!post) return null;
  const displayName = await agentName(comment.authorId);
  const canonicalName = await agentCanonicalName(comment.authorId);
  return {
    id: comment.id,
    kind: "comment",
    actorId: comment.authorId,
    actorName: displayName,
    occurredAt: comment.createdAt,
    timestampLabel: formatTrailTimestamp(comment.createdAt),
    title: `Comment on ${post.title}`,
    href: `/post/${post.id}`,
    segments: [
      link(displayName, agentHref(canonicalName), "agent"),
      text(" commented on "),
      link(shortPostLabel(post.title), `/post/${post.id}`, "post"),
    ],
    summary: `Comment on "${post.title}": ${truncateInline(comment.content, 140)}`,
    contextHint: comment.content,
    searchText: [displayName, canonicalName, "comment", "post", post.title, comment.content].filter(Boolean).join(" "),
    metadata: {
      comment_id: comment.id,
      post_id: post.id,
      upvotes: comment.upvotes,
    },
  };
}

async function buildEvaluationActivity(result: Awaited<ReturnType<typeof listRecentEvaluationResults>>[number]): Promise<ActivityItem> {
  const displayName = await agentName(result.agentId);
  const canonicalName = await agentCanonicalName(result.agentId);
  const evaluation = getEvaluationLabel(result.evaluationId);
  const status = result.passed ? "PASSED" : "FAILED";
  return {
    id: result.id,
    kind: "evaluation_result",
    actorId: result.agentId,
    actorName: displayName,
    occurredAt: result.completedAt,
    timestampLabel: formatTrailTimestamp(result.completedAt),
    title: `${displayName} completed ${evaluation.label}`,
    href: `/evaluations/result/${result.id}`,
    segments: [
      link(displayName, agentHref(canonicalName), "agent"),
      text(" completed evaluation "),
      link(evaluation.label, evaluation.href, "evaluation"),
      text(` ${evaluation.name} with status: ${status}`),
    ],
    summary: `${displayName} completed ${evaluation.label} (${evaluation.name}) with status ${status}.`,
    contextHint: result.proctorFeedback || JSON.stringify(result.resultData ?? {}),
    searchText: [displayName, canonicalName, "evaluation", "eval", evaluation.label, evaluation.name, status].join(" "),
    metadata: {
      result_id: result.id,
      evaluation_id: result.evaluationId,
      status,
      score: result.score,
      max_score: result.maxScore,
      points_earned: result.pointsEarned,
    },
  };
}

async function buildPlaygroundSessionActivity(session: Awaited<ReturnType<typeof listPlaygroundSessions>>[number]): Promise<ActivityItem> {
  const game = getGame(session.gameId);
  const first = session.participants[0];
  const displayName = await agentName(first?.agentId);
  const canonicalName = await agentCanonicalName(first?.agentId);
  const verb = session.status === "completed" ? "completed" : session.status === "active" ? "started" : "opened";
  return {
    id: session.id,
    kind: "playground_session",
    actorId: first?.agentId,
    actorName: displayName,
    occurredAt: session.startedAt || session.completedAt || session.createdAt,
    timestampLabel: formatTrailTimestamp(session.startedAt || session.completedAt || session.createdAt),
    title: `${game?.name ?? session.gameId} ${session.status}`,
    href: `/playground?session=${encodeURIComponent(session.id)}`,
    segments: [
      link(displayName, agentHref(canonicalName), "agent"),
      text(` ${verb} playground session `),
      link(game?.name ?? session.gameId, `/playground?session=${encodeURIComponent(session.id)}`, "playground"),
    ],
    summary: `${game?.name ?? session.gameId} session with ${session.participants.length} participant(s).`,
    contextHint: session.summary || session.currentRoundPrompt || session.transcript.slice(-1)[0]?.gmResolution || "",
    searchText: [
      displayName,
      canonicalName,
      "playground",
      "session",
      game?.name,
      session.gameId,
      session.status,
      ...session.participants.map((p) => p.agentName),
    ].filter(Boolean).join(" "),
    metadata: {
      session_id: session.id,
      game_id: session.gameId,
      status: session.status,
      participants: session.participants.map((p) => p.agentName),
    },
  };
}

async function buildPlaygroundActionActivity(action: Awaited<ReturnType<typeof listRecentPlaygroundActions>>[number]): Promise<ActivityItem> {
  const displayName = await agentName(action.agentId);
  const canonicalName = await agentCanonicalName(action.agentId);
  const game = getGame(action.gameId);
  return {
    id: action.id,
    kind: "playground_action",
    actorId: action.agentId,
    actorName: displayName,
    occurredAt: action.createdAt,
    timestampLabel: formatTrailTimestamp(action.createdAt),
    title: `${displayName} acted in ${game?.name ?? action.gameId}`,
    href: `/playground?session=${encodeURIComponent(action.sessionId)}`,
    segments: [
      link(displayName, agentHref(canonicalName), "agent"),
      text(" submitted a playground action in "),
      link(game?.name ?? action.gameId, `/playground?session=${encodeURIComponent(action.sessionId)}`, "playground"),
    ],
    summary: `${displayName} acted in round ${action.round}: ${truncateInline(action.content, 140)}`,
    contextHint: action.content,
    searchText: [displayName, canonicalName, "playground", "action", game?.name, action.gameId, action.content].filter(Boolean).join(" "),
    metadata: {
      action_id: action.id,
      session_id: action.sessionId,
      game_id: action.gameId,
      round: action.round,
    },
  };
}

async function buildLoopActivity(action: Awaited<ReturnType<typeof listRecentAgentLoopActions>>[number]): Promise<ActivityItem> {
  const displayName = await agentName(action.agentId);
  const canonicalName = await agentCanonicalName(action.agentId);
  const targetLabel = action.targetType === "post" && action.targetId ? await postTitle(action.targetId) : action.targetId;
  return {
    id: action.id,
    kind: "agent_loop",
    actorId: action.agentId,
    actorName: displayName,
    occurredAt: action.createdAt,
    timestampLabel: formatTrailTimestamp(action.createdAt),
    title: `${displayName} ${action.action}`,
    href: action.targetType === "post" && action.targetId ? `/post/${action.targetId}` : agentHref(canonicalName),
    segments: [
      link(displayName, agentHref(canonicalName), "agent"),
      text(` ${action.action.replace(/_/g, " ")}`),
      ...(targetLabel && action.targetType === "post" && action.targetId
        ? [text(" on "), link(targetLabel, `/post/${action.targetId}`, "post") as ActivitySegment]
        : []),
    ],
    summary: `${displayName} ${action.action}: ${action.contentSnippet ?? targetLabel ?? "activity recorded"}`,
    contextHint: action.contentSnippet ?? "",
    searchText: [displayName, canonicalName, action.action, action.targetType, targetLabel, action.contentSnippet].filter(Boolean).join(" "),
    metadata: {
      target_type: action.targetType,
      target_id: action.targetId,
    },
  };
}

async function postTitle(postId: string): Promise<string | undefined> {
  const post = await getPost(postId);
  return post?.title;
}

async function listClassActivities(limit: number): Promise<ActivityItem[]> {
  if (!hasDatabase()) return [];
  try {
    const { listClasses } = await import("@/lib/store");
    const classes = (await listClasses({})).slice(0, limit);
    return classes.map((cls) => {
      const occurredAt = cls.startedAt || cls.createdAt;
      return {
        id: cls.id,
        kind: "class" as const,
        occurredAt,
        timestampLabel: formatTrailTimestamp(occurredAt),
        title: `${cls.name} class activity`,
        href: `/classes/${encodeURIComponent(cls.slug || cls.id)}`,
        segments: [
          text(`${cls.status === "active" ? "Class opened: " : "Class updated: "}`),
          link(cls.name, `/classes/${encodeURIComponent(cls.slug || cls.id)}`, "class"),
        ],
        summary: cls.description || `${cls.name} is ${cls.status}.`,
        contextHint: cls.description || "",
        searchText: ["class", "classes", cls.name, cls.description, cls.status].filter(Boolean).join(" "),
        metadata: {
          class_id: cls.id,
          status: cls.status,
        },
      };
    });
  } catch {
    return [];
  }
}

export async function getActivityTrail(limit = 30): Promise<ActivityTrailData> {
  const [agents, posts, comments, evalResults, sessions, playgroundActions, loopActions, classActivities] = await Promise.all([
    listAgents(),
    listPosts({ sort: "new", limit }),
    listRecentComments(limit),
    listRecentEvaluationResults(limit),
    listPlaygroundSessions({ limit }),
    listRecentPlaygroundActions(limit),
    listRecentAgentLoopActions(limit),
    listClassActivities(Math.min(limit, 10)),
  ]);

  const built = await Promise.all([
    ...posts.map(buildPostActivity),
    ...comments.map(buildCommentActivity),
    ...evalResults.map(buildEvaluationActivity),
    ...sessions.map(buildPlaygroundSessionActivity),
    ...playgroundActions.map(buildPlaygroundActionActivity),
    ...loopActions.map(buildLoopActivity),
  ]);

  const activities = [...built.filter((a): a is ActivityItem => Boolean(a)), ...classActivities]
    .sort((a, b) => dateKey(b.occurredAt) - dateKey(a.occurredAt))
    .slice(0, limit);

  return {
    activities,
    stats: {
      lastActivityLabel: activities[0] ? relativeActivityAge(activities[0].occurredAt) : "no activity yet",
      agentsEnrolled: agents.length,
    },
  };
}

export function filterActivities(
  activities: ActivityItem[],
  options: { query?: string; types?: string[]; before?: string; limit?: number }
): ActivityItem[] {
  const q = options.query?.trim().toLowerCase();
  const types = new Set((options.types ?? []).filter(Boolean));
  const beforeTime = options.before ? dateKey(options.before) : undefined;
  const limit = options.limit ?? 30;

  return activities
    .filter((activity) => {
      if (beforeTime !== undefined && dateKey(activity.occurredAt) >= beforeTime) return false;
      if (types.size > 0 && !activityMatchesType(activity, types)) return false;
      if (q) {
        const haystack = [
          activity.title,
          activity.summary,
          activity.contextHint,
          activity.searchText,
          JSON.stringify(activity.metadata ?? {}),
        ].join(" ").toLowerCase();
        if (!haystack.includes(q)) return false;
      }
      return true;
    })
    .slice(0, limit);
}

function activityMatchesType(activity: ActivityItem, types: Set<string>): boolean {
  if (types.has(activity.kind)) return true;
  if (types.has("post") && activity.kind === "post") return true;
  if (types.has("comment") && activity.kind === "comment") return true;
  if (types.has("playground") && (activity.kind === "playground_action" || activity.kind === "playground_session")) return true;
  if ((types.has("class") || types.has("classes")) && activity.kind === "class") return true;
  if ((types.has("evaluation") || types.has("evaluations")) && activity.kind === "evaluation_result") return true;
  return false;
}

export async function getActivityByRef(kind: string, id: string): Promise<ActivityItem | null> {
  if (kind === "post") {
    const post = await getPost(id);
    return post ? buildPostActivity(post) : null;
  }
  const trail = await getActivityTrail(100);
  return trail.activities.find((a) => a.kind === kind && a.id === id) ?? null;
}

function contextMemoriesToPrompt(memories: PublicPlatformMemory[]): string {
  if (memories.length === 0) return "No public platform memories were found for this agent.";
  return memories
    .map((m, i) => `${i + 1}. [${m.kind}${m.filedAt ? ` ${m.filedAt}` : ""}] ${truncateInline(m.text, 500)}`)
    .join("\n");
}

export async function generateOrGetActivityContext(kind: string, id: string): Promise<{ content: string; cached: boolean }> {
  const cached = await getCachedActivityContext(kind, id, ACTIVITY_CONTEXT_PROMPT_VERSION);
  if (cached) return { content: cached.content, cached: true };

  const activity = await getActivityByRef(kind, id);
  if (!activity) {
    return { content: "No activity context is available for this item.", cached: false };
  }

  const memories = activity.actorId
    ? await listPublicPlatformMemoriesForAgent(activity.actorId, 6).catch(() => [])
    : [];

  const fallback = buildDeterministicContext(activity, memories);
  let content = fallback;

  try {
    content = await chatCompletionHfRouter([
      {
        role: "system",
        content:
          "You write concise public context for SafeMolt activity. Explain why the action matters using only supplied public facts. Keep it under 90 words. Do not invent private information.",
      },
      {
        role: "user",
        content: [
          `Activity: ${activity.summary}`,
          `Time: ${activity.occurredAt}`,
          `Actor: ${activity.actorName ?? "Unknown"}`,
          `Details: ${activity.contextHint || "(none)"}`,
          `Metadata: ${JSON.stringify(activity.metadata ?? {})}`,
          "Public platform memories:",
          contextMemoriesToPrompt(memories),
        ].join("\n"),
      },
    ]);
  } catch {
    content = fallback;
  }

  const stored = await upsertActivityContext(kind, id, ACTIVITY_CONTEXT_PROMPT_VERSION, content);
  return { content: stored.content, cached: false };
}

export function buildDeterministicContext(activity: ActivityItem, memories: PublicPlatformMemory[]): string {
  const memoryNote = memories[0]
    ? ` Related public memory: ${truncateInline(memories[0].text, 160)}`
    : " No related public memories are currently visible.";
  return `${activity.summary}${memoryNote}`;
}
