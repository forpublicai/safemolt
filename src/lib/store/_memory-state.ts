import type { StoredAgent, StoredGroup, StoredPost, StoredComment, VettingChallenge, StoredPostVote, StoredCommentVote, StoredAnnouncement, StoredActivityContext, StoredActivityFeedItem, StoredActivityFeedOptions, StoredNotification, AtprotoIdentity, AtprotoBlob, StoredSchool, StoredSchoolProfessor } from "@/lib/store-types";
import type { CertificationJob, EvaluationRegistration } from '@/lib/evaluations/types';
import type { AgentMemory, PlaygroundSession, SessionAction } from '@/lib/playground/types';

/** Shared in-memory state and private helpers for domain memory stores. */

// Cache maps on globalThis to survive HMR in development
export const globalStore = globalThis as typeof globalThis & {
  __safemolt_agents?: Map<string, StoredAgent>;
  __safemolt_apiKeyToAgentId?: Map<string, string>;
  __safemolt_claimTokenToAgentId?: Map<string, string>;
  __safemolt_groups?: Map<string, StoredGroup>;
  __safemolt_posts?: Map<string, StoredPost>;
  __safemolt_comments?: Map<string, StoredComment>;
  __safemolt_following?: Map<string, Set<string>>;
  __safemolt_lastPostAt?: Map<string, number>;
  __safemolt_lastCommentAt?: Map<string, number>;
  __safemolt_commentCountToday?: Map<string, { date: string; count: number }>;
  __safemolt_vettingChallenges?: Map<string, VettingChallenge>;
  __safemolt_postVotes?: Map<string, StoredPostVote>;  // keyed by "agentId:postId"
  __safemolt_commentVotes?: Map<string, StoredCommentVote>;  // keyed by "agentId:commentId"
  __safemolt_atprotoIdentities?: Map<string, AtprotoIdentity>;  // keyed by handle
  __safemolt_atprotoBlobs?: Map<string, AtprotoBlob>;  // keyed by "agentId:cid"
  __safemolt_schools?: Map<string, StoredSchool>;  // keyed by school id
  __safemolt_schoolProfessors?: Map<string, StoredSchoolProfessor>;  // keyed by "schoolId:professorId"
  __safemolt_activityContexts?: Map<string, StoredActivityContext>;
  __safemolt_activityEvents?: Map<string, StoredActivityFeedItem>;  // keyed by "kind:entityId"
  __safemolt_notifications?: Map<string, StoredNotification>;
  __safemolt_newsletterSubscribers?: Map<string, NewsletterSubscriberRow>;  // keyed by lowercase email
  __safemolt_rateWindows?: Map<string, RateWindowEntry>;  // keyed by "key" (window alignment inside the entry)
  __safemolt_playgroundAgentMemories?: Map<string, AgentMemory>;  // keyed by "agentId:sessionId" (M11-1b D5)
};

export interface NewsletterSubscriberRow {
  id: string;
  email: string;
  subscribedAt: string;
  source: string | null;
  confirmationToken: string;
  confirmedAt: string | null;
  unsubscribedAt: string | null;
  confirmationSentAt: string | null;
}

export interface RateWindowEntry {
  windowStart: number;
  count: number;
}

export const agents = globalStore.__safemolt_agents ??= new Map<string, StoredAgent>();

export const apiKeyToAgentId = globalStore.__safemolt_apiKeyToAgentId ??= new Map<string, string>();

export const claimTokenToAgentId = globalStore.__safemolt_claimTokenToAgentId ??= new Map<string, string>();

export const groups = globalStore.__safemolt_groups ??= new Map<string, StoredGroup>();

export const posts = globalStore.__safemolt_posts ??= new Map<string, StoredPost>();

export const comments = globalStore.__safemolt_comments ??= new Map<string, StoredComment>();

export const following = globalStore.__safemolt_following ??= new Map<string, Set<string>>();

export const lastPostAt = globalStore.__safemolt_lastPostAt ??= new Map<string, number>();

export const lastCommentAt = globalStore.__safemolt_lastCommentAt ??= new Map<string, number>();

export const commentCountToday = globalStore.__safemolt_commentCountToday ??= new Map<string, { date: string; count: number }>();

export const vettingChallenges = globalStore.__safemolt_vettingChallenges ??= new Map<string, VettingChallenge>();

export const postVotes = globalStore.__safemolt_postVotes ??= new Map<string, StoredPostVote>();

export const commentVotes = globalStore.__safemolt_commentVotes ??= new Map<string, StoredCommentVote>();

export const atprotoIdentitiesByHandle = globalStore.__safemolt_atprotoIdentities ??= new Map<string, AtprotoIdentity>();

export const atprotoBlobs = globalStore.__safemolt_atprotoBlobs ??= new Map<string, AtprotoBlob>();

export const schoolsMap = globalStore.__safemolt_schools ??= new Map<string, StoredSchool>();

export const schoolProfessorsMap = globalStore.__safemolt_schoolProfessors ??= new Map<string, StoredSchoolProfessor>();

export const activityContexts = globalStore.__safemolt_activityContexts ??= new Map<string, StoredActivityContext>();

export const activityEvents = globalStore.__safemolt_activityEvents ??= new Map<string, StoredActivityFeedItem>();
export const notifications = globalStore.__safemolt_notifications ??= new Map<string, StoredNotification>();
export const newsletterSubscribers = globalStore.__safemolt_newsletterSubscribers ??= new Map<string, NewsletterSubscriberRow>();
export const rateWindows = globalStore.__safemolt_rateWindows ??= new Map<string, RateWindowEntry>();
export const playgroundAgentMemories = globalStore.__safemolt_playgroundAgentMemories ??= new Map<string, AgentMemory>();

// Imported and re-exported from the one definition both stores share, so a window cannot be raised
// in db mode and left alone in memory mode (M11-1 C16). Imported rather than only re-exported
// because the claim helpers below evaluate them.
import { COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY, POST_COOLDOWN_MS } from "./rate-limit-windows";

export { POST_COOLDOWN_MS, COMMENT_COOLDOWN_MS, MAX_COMMENTS_PER_DAY };

/**
 * Public entity id. Not a credential (M11-1 C17) — predictability costs nothing here, and these
 * values appear in public payloads anyway. Credentials come from `@/lib/credentials`.
 */
export function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function touchAgentActive(agentId: string): void {
  const a = agents.get(agentId);
  if (a) agents.set(agentId, { ...a, lastActiveAt: new Date().toISOString() });
}

// ==================== Rate-limit claims (M11-1 C16) ====================
//
// The memory-mode counterparts of the db store's gating statements. Both are **synchronous**, and
// that is the whole guarantee: every `await` yields the event loop, so a limit read in one call and
// stamped in another reproduces exactly the race the db store had — in the mode Jest exercises.
// Read and write here happen in one uninterruptible section, so concurrent callers cannot both pass.
//
// Each returns whether the caller may proceed, and charges the allowance only when it says yes: a
// refusal that re-stamped the window would extend the caller's own cooldown on every retry.

/** Claim one post allowance, or return false if the cooldown refuses it. */
export function claimPostAllowance(agentId: string): boolean {
  const now = Date.now();
  const last = lastPostAt.get(agentId);
  if (last !== undefined && now - last < POST_COOLDOWN_MS) return false;
  lastPostAt.set(agentId, now);
  return true;
}

/** Claim one comment allowance against both the cooldown and the daily cap, or return false. */
export function claimCommentAllowance(agentId: string): boolean {
  const now = Date.now();
  const today = new Date().toISOString().slice(0, 10);
  const last = lastCommentAt.get(agentId);
  const previous = commentCountToday.get(agentId);
  const usedToday = previous?.date === today ? previous.count : 0;

  if (last !== undefined && now - last < COMMENT_COOLDOWN_MS) return false;
  if (usedToday >= MAX_COMMENTS_PER_DAY) return false;

  lastCommentAt.set(agentId, now);
  commentCountToday.set(agentId, { date: today, count: usedToday + 1 });
  return true;
}

// ==================== Vote Tracking Functions ====================

/**
 * Generate a unique key for vote tracking based on agent and target IDs.
 * Used to key votes in the postVotes and commentVotes maps.
 */
export function getVoteKey(agentId: string, targetId: string): string {
  return `${agentId}:${targetId}`;
}

export function memoryIngestWatermarkRef(): { v: string } {
  const g = globalThis as typeof globalThis & { __safemolt_memory_ingest_wm?: { v: string } };
  if (!g.__safemolt_memory_ingest_wm) {
    g.__safemolt_memory_ingest_wm = { v: "1970-01-01T00:00:00.000Z" };
  }
  return g.__safemolt_memory_ingest_wm;
}

// Filter semantics live in ./activity/kinds so the DB store, memory store, and
// activity renderer share one vocabulary. Re-exported for existing importers.
export { normalizeActivityTypeSet, activityFeedIncludes } from "./activity/kinds";
import { normalizeActivityTypeSet, activityFeedIncludes } from "./activity/kinds";

export function activityFeedMatches(item: StoredActivityFeedItem, options: StoredActivityFeedOptions): boolean {
  const beforeTime = options.before ? Date.parse(options.before) : undefined;
  if (beforeTime !== undefined && Number.isFinite(beforeTime)) {
    const itemTime = Date.parse(item.occurredAt);
    if (itemTime > beforeTime) return false;
    if (itemTime === beforeTime && options.beforeId && (item.cursorId ?? item.id) >= options.beforeId) return false;
    if (itemTime === beforeTime && !options.beforeId) return false;
  }
  const sinceTime = options.since ? Date.parse(options.since) : undefined;
  if (sinceTime !== undefined && Number.isFinite(sinceTime)) {
    if (Date.parse(item.occurredAt) <= sinceTime) return false;
  }
  if (options.actorId && item.actorId !== options.actorId) return false;
  if (!activityFeedIncludes(item.kind, normalizeActivityTypeSet(options.types))) return false;
  const q = options.query?.trim().toLowerCase();
  if (!q) return true;
  return [
    item.title,
    item.summary,
    item.contextHint,
    item.searchText,
    JSON.stringify(item.metadata ?? {}),
  ].join(" ").toLowerCase().includes(q);
}

export function memoryAgentNames(agentId?: string): { display: string; canonical: string } {
  if (!agentId) return { display: "Unknown", canonical: "unknown" };
  const agent = agents.get(agentId);
  return {
    display: agent?.displayName?.trim() || agent?.name || agentId,
    canonical: agent?.name || agentId,
  };
}

export function activityContextKey(activityKind: string, activityId: string, promptVersion: string): string {
  return `${activityKind}:${activityId}:${promptVersion}`;
}

export function activityEventKey(kind: string, entityId: string): string {
  return `${kind}:${entityId}`;
}

export function generateChallengeId(): string {
  return `vc_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// ==================== Evaluation Functions ====================

export const evaluationRegistrations = new Map<string, EvaluationRegistration>();

export const evaluationResults = new Map<string, {
  id: string;
  registrationId: string;
  agentId: string;
  evaluationId: string;
  passed: boolean;
  score?: number;
  maxScore?: number;
  pointsEarned?: number;
  resultData?: Record<string, unknown>;
  completedAt: string;
  proctorAgentId?: string;
  proctorFeedback?: string;
  evaluationVersion?: string;
  schoolId?: string;
}>();

export const evaluationSessions = new Map<string, {
  id: string;
  evaluationId: string;
  kind: string;
  registrationId?: string;
  status: string;
  startedAt: string;
  endedAt?: string;
}>();

export const evaluationSessionParticipants = new Map<string, {
  id: string;
  sessionId: string;
  agentId: string;
  role: string;
  joinedAt: string;
}>();

export const evaluationMessages = new Map<string, {
  id: string;
  sessionId: string;
  senderAgentId: string;
  role: string;
  content: string;
  createdAt: string;
  sequence: number;
}>();

export function generateEvaluationId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

// The shared CertificationJob type, not a duplicated inline shape — M11-1 C22 added the judging
// lease fields and the memory store must carry them with db-identical semantics.
export const certificationJobs = new Map<string, CertificationJob>();

// Extend globalThis for HMR persistence
export const pgGlobalStore = globalThis as typeof globalThis & {
  __safemolt_pg_sessions?: Map<string, PlaygroundSession>;
  __safemolt_pg_actions?: Map<string, SessionAction>;
};

export const playgroundSessions = pgGlobalStore.__safemolt_pg_sessions ??= new Map<string, PlaygroundSession>();

export const playgroundActions = pgGlobalStore.__safemolt_pg_actions ??= new Map<string, SessionAction>();

let postIdCounter = 1;
let commentIdCounter = 1;

export function nextPostId(): number {
  return postIdCounter++;
}

export function nextCommentId(): number {
  return commentIdCounter++;
}

export const announcementState: { current: StoredAnnouncement | null } = { current: null };
