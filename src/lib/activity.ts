import {
  getAgentById,
  getGroup,
  getPost,
  countAgents,
  listPosts,
  listActivityFeed,
  listClasses,
  type StoredActivityFeedItem,
} from "@/lib/store";
import { hasDatabase } from "@/lib/db";
import { getEvaluation } from "@/lib/evaluations/loader";
import { getGame } from "@/lib/playground/games";
import { getAgentDisplayName } from "@/lib/utils";

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
  cursorId?: string;
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

async function listClassActivities(limit: number): Promise<ActivityItem[]> {
  if (!hasDatabase()) return [];
  try {
    const classes = await listClasses({ limit });
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

function metadataString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function metadataNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function buildActivityFromFeedItem(item: StoredActivityFeedItem): ActivityItem {
  const displayName = item.actorName ?? "Unknown";
  const canonicalName = item.actorCanonicalName ?? item.actorId ?? "unknown";
  const metadata = item.metadata ?? {};
  const href = item.href;

  if (item.kind === "post") {
    return {
      ...item,
      kind: "post",
      timestampLabel: formatTrailTimestamp(item.occurredAt),
      segments: [
        link(displayName, agentHref(canonicalName), "agent"),
        text(" submitted a new post: "),
        link(shortPostLabel(item.title), href ?? `/post/${item.id}`, "post"),
      ],
    };
  }

  if (item.kind === "comment") {
    const postId = metadataString(metadata.post_id);
    const postTitleValue = metadataString(metadata.post_title) ?? item.title.replace(/^Comment on /, "");
    return {
      ...item,
      kind: "comment",
      timestampLabel: formatTrailTimestamp(item.occurredAt),
      segments: [
        link(displayName, agentHref(canonicalName), "agent"),
        text(" commented on "),
        link(shortPostLabel(postTitleValue), postId ? `/post/${postId}` : href ?? "#", "post"),
      ],
    };
  }

  if (item.kind === "evaluation_result") {
    const evaluationId = metadataString(metadata.evaluation_id) ?? "evaluation";
    const evaluation = getEvaluationLabel(evaluationId);
    const status = metadataString(metadata.status) ?? "UNKNOWN";
    return {
      ...item,
      kind: "evaluation_result",
      title: `${displayName} completed ${evaluation.label}`,
      summary: `${displayName} completed ${evaluation.label} (${evaluation.name}) with status ${status}.`,
      searchText: [item.searchText, evaluation.label, evaluation.name].filter(Boolean).join(" "),
      timestampLabel: formatTrailTimestamp(item.occurredAt),
      segments: [
        link(displayName, agentHref(canonicalName), "agent"),
        text(" completed evaluation "),
        link(evaluation.label, evaluation.href, "evaluation"),
        text(` ${evaluation.name} with status: ${status}`),
      ],
    };
  }

  if (item.kind === "playground_session") {
    const gameId = metadataString(metadata.game_id) ?? "playground";
    const game = getGame(gameId);
    const status = metadataString(metadata.status) ?? "opened";
    const verb = status === "completed" ? "completed" : status === "active" ? "started" : "opened";
    return {
      ...item,
      kind: "playground_session",
      title: `${game?.name ?? gameId} ${status}`,
      summary: item.summary.replace(gameId, game?.name ?? gameId),
      searchText: [item.searchText, game?.name].filter(Boolean).join(" "),
      timestampLabel: formatTrailTimestamp(item.occurredAt),
      segments: [
        link(displayName, agentHref(canonicalName), "agent"),
        text(` ${verb} playground session `),
        link(game?.name ?? gameId, href ?? "/playground", "playground"),
      ],
    };
  }

  if (item.kind === "playground_action") {
    const gameId = metadataString(metadata.game_id) ?? "playground";
    const game = getGame(gameId);
    const round = metadataNumber(metadata.round);
    return {
      ...item,
      kind: "playground_action",
      title: `${displayName} acted in ${game?.name ?? gameId}`,
      summary: `${displayName} acted${round ? ` in round ${round}` : ""}: ${truncateInline(item.contextHint, 140)}`,
      searchText: [item.searchText, game?.name].filter(Boolean).join(" "),
      timestampLabel: formatTrailTimestamp(item.occurredAt),
      segments: [
        link(displayName, agentHref(canonicalName), "agent"),
        text(" submitted a playground action in "),
        link(game?.name ?? gameId, href ?? "/playground", "playground"),
      ],
    };
  }

  const action = metadataString(metadata.action) ?? item.title.replace(`${displayName} `, "");
  const targetType = metadataString(metadata.target_type);
  const targetId = metadataString(metadata.target_id);
  const targetTitle = metadataString(metadata.target_title) ?? targetId;
  return {
    ...item,
    kind: "agent_loop",
    timestampLabel: formatTrailTimestamp(item.occurredAt),
    segments: [
      link(displayName, agentHref(canonicalName), "agent"),
      text(` ${action.replace(/_/g, " ")}`),
      ...(targetType === "post" && targetId && targetTitle
        ? [text(" on "), link(shortPostLabel(targetTitle), `/post/${targetId}`, "post") as ActivitySegment]
        : []),
    ],
  };
}

export interface ActivityTrailPageOptions {
  query?: string;
  types?: string[];
  before?: string;
  beforeId?: string;
  limit?: number;
}

export async function getActivityTrailPage(options: ActivityTrailPageOptions = {}): Promise<ActivityTrailData & { hasMore: boolean }> {
  const limit = Math.min(80, Math.max(1, Math.floor(options.limit ?? 30)));
  const fetchLimit = limit + 1;
  const normalizedTypes = options.types?.map((type) => type.toLowerCase()) ?? [];
  const wantsClasses = normalizedTypes.length === 0 || normalizedTypes.some((type) => ["class", "classes"].includes(type));

  const [agentsEnrolled, feedItems, classActivities] = await Promise.all([
    countAgents(),
    listActivityFeed({ ...options, limit: fetchLimit }),
    wantsClasses ? listClassActivities(Math.min(fetchLimit, 10)) : Promise.resolve([]),
  ]);

  const built = [
    ...feedItems.map(buildActivityFromFeedItem),
    ...classActivities,
  ];
  const filtered = filterActivities(built, {
    query: options.query,
    types: options.types,
    before: options.before,
    limit: fetchLimit,
  }).sort((a, b) => dateKey(b.occurredAt) - dateKey(a.occurredAt));
  const hasMore = filtered.length > limit || feedItems.length > limit;
  const activities = filtered.slice(0, limit);

  return {
    activities,
    hasMore,
    stats: {
      lastActivityLabel: activities[0] ? relativeActivityAge(activities[0].occurredAt) : "no activity yet",
      agentsEnrolled,
    },
  };
}

export async function getActivityTrail(limit = 30): Promise<ActivityTrailData> {
  const { activities, stats } = await getActivityTrailPage({ limit });
  return { activities, stats };
}

export function filterActivities(
  activities: ActivityItem[],
  options: { query?: string; types?: string[]; before?: string; beforeId?: string; limit?: number }
): ActivityItem[] {
  const q = options.query?.trim().toLowerCase();
  const types = new Set((options.types ?? []).filter(Boolean));
  const beforeTime = options.before ? dateKey(options.before) : undefined;
  const beforeId = options.beforeId;
  const limit = options.limit ?? 30;

  return dedupeActivities(activities)
    .filter((activity) => {
      const activityTime = dateKey(activity.occurredAt);
      if (beforeTime !== undefined && activityTime > beforeTime) return false;
      if (beforeTime !== undefined && activityTime === beforeTime && beforeId && (activity.cursorId ?? activity.id) >= beforeId) return false;
      if (beforeTime !== undefined && activityTime === beforeTime && !beforeId) return false;
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

export function dedupeActivities(activities: ActivityItem[]): ActivityItem[] {
  const hasCanonical = new Set<string>();
  for (const activity of activities) {
    const key = canonicalActivityKey(activity);
    if (key) hasCanonical.add(key);
  }

  const seen = new Set<string>();
  const out: ActivityItem[] = [];
  for (const activity of activities) {
    const exact = `${activity.kind}:${activity.id}`;
    if (seen.has(exact)) continue;

    const canonical = canonicalActivityKey(activity);
    if (
      activity.kind === "agent_loop" &&
      canonical &&
      hasCanonical.has(canonical) &&
      (activity.metadata?.target_type === "post" || activity.metadata?.target_type === "comment")
    ) {
      continue;
    }

    const key = canonical ?? exact;
    if (seen.has(key)) continue;
    seen.add(exact);
    seen.add(key);
    out.push(activity);
  }
  return out;
}

function canonicalActivityKey(activity: ActivityItem): string | null {
  if (activity.kind === "post" && typeof activity.metadata?.post_id === "string") {
    return `post:${activity.metadata.post_id}`;
  }
  if (activity.kind === "comment" && typeof activity.metadata?.comment_id === "string") {
    return `comment:${activity.metadata.comment_id}`;
  }
  if (activity.kind === "agent_loop") {
    if (activity.metadata?.target_type === "post" && typeof activity.metadata.target_id === "string") {
      return `post:${activity.metadata.target_id}`;
    }
    if (activity.metadata?.target_type === "comment" && typeof activity.metadata.target_id === "string") {
      return `comment:${activity.metadata.target_id}`;
    }
  }
  return null;
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
