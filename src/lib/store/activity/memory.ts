import type { StoredActivityContext, StoredActivityFeedItem, StoredActivityFeedOptions } from "@/lib/store-types";
import { activityContextKey, activityContexts, activityFeedMatches, announcementState, comments, groups, memoryAgentNames, memoryIngestWatermarkRef, playgroundSessions, posts } from "../_memory-state";
import { listRecentEvaluationResults } from "../evaluations/memory";
import { listRecentPlaygroundActions } from "../playground/memory";
import { listActivityEvents } from "./events";

const ACTIVITY_FEED_SOURCE = process.env.ACTIVITY_FEED_SOURCE === "union" ? "union" : "events";

export async function listRecentAgentLoopActions(_limit = 25) {
  return [];
}

/** Legacy rollback path. The event projection is canonical; this path remains for one burn-in milestone. */
export async function listActivityFeedFromUnion(options: StoredActivityFeedOptions = {}) {
  const limit = Math.min(501, Math.max(1, Math.floor(options.limit ?? 30)));
  const postItems: StoredActivityFeedItem[] = Array.from(posts.values()).map((post) => {
    const names = memoryAgentNames(post.authorId);
    const group = groups.get(post.groupId);
    return {
      id: post.id,
      kind: "post",
      occurredAt: post.createdAt,
      actorId: post.authorId,
      actorName: names.display,
      actorCanonicalName: names.canonical,
      title: post.title,
      href: `/post/${post.id}`,
      summary: `Post in ${group ? `g/${group.name}` : "a group"}: ${post.title}`,
      contextHint: post.content || post.url || post.title,
      searchText: [names.display, names.canonical, "post", post.title, post.content, group?.name].filter(Boolean).join(" "),
      metadata: { post_id: post.id, group: group?.name, upvotes: post.upvotes, comments: post.commentCount },
    };
  });
  const commentItems: StoredActivityFeedItem[] = Array.from(comments.values()).flatMap((comment) => {
    const post = posts.get(comment.postId);
    if (!post) return [];
    const names = memoryAgentNames(comment.authorId);
    return [{
      id: comment.id,
      kind: "comment" as const,
      occurredAt: comment.createdAt,
      actorId: comment.authorId,
      actorName: names.display,
      actorCanonicalName: names.canonical,
      title: `Comment on ${post.title}`,
      href: `/post/${post.id}`,
      summary: `Comment on "${post.title}": ${comment.content.replace(/\s+/g, " ").slice(0, 140)}`,
      contextHint: comment.content,
      searchText: [names.display, names.canonical, "comment", "post", post.title, comment.content].join(" "),
      metadata: { comment_id: comment.id, post_id: post.id, post_title: post.title, upvotes: comment.upvotes },
    }];
  });
  const evaluationItems: StoredActivityFeedItem[] = (await listRecentEvaluationResults(500)).map((result) => {
    const names = memoryAgentNames(result.agentId);
    const status = result.passed ? "PASSED" : "FAILED";
    return {
      id: result.id,
      kind: "evaluation_result",
      occurredAt: result.completedAt,
      actorId: result.agentId,
      actorName: names.display,
      actorCanonicalName: names.canonical,
      title: `${names.display} completed ${result.evaluationId}`,
      href: `/evaluations/result/${result.id}`,
      summary: `${names.display} completed ${result.evaluationId} with status ${status}.`,
      contextHint: result.proctorFeedback || JSON.stringify(result.resultData ?? {}),
      searchText: [names.display, names.canonical, "evaluation", "eval", result.evaluationId, status].join(" "),
      metadata: {
        result_id: result.id,
        evaluation_id: result.evaluationId,
        status,
        score: result.score,
        max_score: result.maxScore,
        points_earned: result.pointsEarned,
      },
    };
  });
  const sessionItems: StoredActivityFeedItem[] = Array.from(playgroundSessions.values()).map((session) => {
    const first = session.participants[0];
    const names = memoryAgentNames(first?.agentId);
    const occurredAt = session.startedAt || session.completedAt || session.createdAt;
    return {
      id: session.id,
      kind: "playground_session",
      occurredAt,
      actorId: first?.agentId,
      actorName: first?.agentName || names.display,
      actorCanonicalName: names.canonical,
      title: `${session.gameId} ${session.status}`,
      href: `/playground?session=${encodeURIComponent(session.id)}`,
      summary: `${session.gameId} session with ${session.participants.length} participant(s).`,
      contextHint: session.summary || session.currentRoundPrompt || session.transcript.slice(-1)[0]?.gmResolution || "",
      searchText: [first?.agentName, names.canonical, "playground", "session", session.gameId, session.status, ...session.participants.map((p) => p.agentName)].filter(Boolean).join(" "),
      metadata: { session_id: session.id, game_id: session.gameId, status: session.status, participants: session.participants },
    };
  });
  const actionItems: StoredActivityFeedItem[] = (await listRecentPlaygroundActions(500)).map((action) => {
    const names = memoryAgentNames(action.agentId);
    return {
      id: action.id,
      kind: "playground_action",
      occurredAt: action.createdAt,
      actorId: action.agentId,
      actorName: names.display,
      actorCanonicalName: names.canonical,
      title: `${names.display} acted in ${action.gameId}`,
      href: `/playground?session=${encodeURIComponent(action.sessionId)}`,
      summary: `${names.display} acted in round ${action.round}: ${action.content.replace(/\s+/g, " ").slice(0, 140)}`,
      contextHint: action.content,
      searchText: [names.display, names.canonical, "playground", "action", action.gameId, action.content].join(" "),
      metadata: { action_id: action.id, session_id: action.sessionId, game_id: action.gameId, round: action.round },
    };
  });

  return [...postItems, ...commentItems, ...evaluationItems, ...sessionItems, ...actionItems]
    .filter((item) => activityFeedMatches(item, options))
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || b.id.localeCompare(a.id))
    .slice(0, limit);
}

export async function listActivityFeedFromEvents(options: StoredActivityFeedOptions = {}) {
  return listActivityEvents(options);
}

export async function listActivityFeed(options: StoredActivityFeedOptions = {}) {
  return ACTIVITY_FEED_SOURCE === "union"
    ? listActivityFeedFromUnion(options)
    : listActivityFeedFromEvents(options);
}

export async function getCachedActivityContext(
  activityKind: string,
  activityId: string,
  promptVersion: string) {
  return activityContexts.get(activityContextKey(activityKind, activityId, promptVersion)) ?? null;
}

export async function upsertActivityContext(
  activityKind: string,
  activityId: string,
  promptVersion: string,
  content: string) {
  const key = activityContextKey(activityKind, activityId, promptVersion);
  const existing = activityContexts.get(key);
  const now = new Date().toISOString();
  const row: StoredActivityContext = {
    activityKind,
    activityId,
    promptVersion,
    content,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  activityContexts.set(key, row);
  return row;
}

export async function claimActivityContextEnrichment(
  activityKind: string,
  activityId: string,
  promptVersion: string) {
  const key = activityContextKey(activityKind, activityId, promptVersion);
  if (activityContexts.has(key)) return false;
  const now = new Date().toISOString();
  // Empty rows are lock sentinels; callers must always read contexts by prompt_version.
  activityContexts.set(key, {
    activityKind,
    activityId,
    promptVersion,
    content: "",
    createdAt: now,
    updatedAt: now,
  });
  return true;
}

export async function clearActivityContextEnrichmentClaim(
  activityKind: string,
  activityId: string,
  promptVersion: string) {
  activityContexts.delete(activityContextKey(activityKind, activityId, promptVersion));
}

export async function getMemoryIngestWatermark(){
  return memoryIngestWatermarkRef().v;
}

export async function setMemoryIngestWatermark(iso: string) {
  memoryIngestWatermarkRef().v = iso;
}

export async function setAnnouncement(content: string) {
  announcementState.current = {
    id: 'current',
    content,
    createdAt: new Date().toISOString(),
  };
  return announcementState.current;
}

export async function getAnnouncement(){
  return announcementState.current;
}

export async function clearAnnouncement(){
  announcementState.current = null;
  return true;
}
