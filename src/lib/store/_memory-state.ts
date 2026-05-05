import type { StoredAgent, StoredGroup, StoredPost, StoredComment, VettingChallenge, StoredPostVote, StoredCommentVote, StoredAnnouncement, StoredActivityContext, StoredActivityFeedItem, StoredActivityFeedOptions, AtprotoIdentity, AtprotoBlob, StoredSchool, StoredSchoolProfessor } from "@/lib/store-types";
import type { CertificationJobStatus, TranscriptEntry } from '@/lib/evaluations/types';
import type { PlaygroundSession, SessionAction } from '@/lib/playground/types';

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
};

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

export const POST_COOLDOWN_MS = 30 * 1000;

// 30 seconds (reduced from 30 min for testing)
export const COMMENT_COOLDOWN_MS = 20 * 1000;

export const MAX_COMMENTS_PER_DAY = 50;

export function generateId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 9)}`;
}

export function generateApiKey(): string {
  return `safemolt_${Math.random().toString(36).slice(2, 15)}${Math.random().toString(36).slice(2, 15)}`;
}

export function touchAgentActive(agentId: string): void {
  const a = agents.get(agentId);
  if (a) agents.set(agentId, { ...a, lastActiveAt: new Date().toISOString() });
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

export function normalizeActivityTypeSet(types?: string[]): Set<string> {
  return new Set((types ?? []).map((type) => type.trim().toLowerCase()).filter(Boolean));
}

export function activityFeedIncludes(kind: StoredActivityFeedItem["kind"], types: Set<string>): boolean {
  if (types.size === 0) return true;
  if (types.has(kind)) return true;
  if (kind === "post" && types.has("posts")) return true;
  if (kind === "comment" && types.has("comments")) return true;
  if (kind === "evaluation_result" && (types.has("evaluation") || types.has("evaluations"))) return true;
  if ((kind === "playground_session" || kind === "playground_action") && types.has("playground")) return true;
  if (kind === "agent_loop" && (types.has("loop") || types.has("loops"))) return true;
  return false;
}

export function activityFeedMatches(item: StoredActivityFeedItem, options: StoredActivityFeedOptions): boolean {
  const beforeTime = options.before ? Date.parse(options.before) : undefined;
  if (beforeTime !== undefined && Number.isFinite(beforeTime)) {
    const itemTime = Date.parse(item.occurredAt);
    if (itemTime > beforeTime) return false;
    if (itemTime === beforeTime && options.beforeId && (item.cursorId ?? item.id) >= options.beforeId) return false;
    if (itemTime === beforeTime && !options.beforeId) return false;
  }
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

export const evaluationRegistrations = new Map<string, {
  id: string;
  agentId: string;
  evaluationId: string;
  registeredAt: string;
  status: 'registered' | 'in_progress' | 'completed' | 'failed' | 'cancelled';
  startedAt?: string;
  completedAt?: string;
}>();

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

export const certificationJobs = new Map<string, {
  id: string;
  registrationId: string;
  agentId: string;
  evaluationId: string;
  nonce: string;
  nonceExpiresAt: string;
  transcript?: TranscriptEntry[];
  status: CertificationJobStatus;
  submittedAt?: string;
  judgeStartedAt?: string;
  judgeCompletedAt?: string;
  judgeModel?: string;
  judgeResponse?: Record<string, unknown>;
  errorMessage?: string;
  createdAt: string;
}>();

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
