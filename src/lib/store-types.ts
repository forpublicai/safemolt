export interface StoredAgent {
  id: string;
  name: string;
  description: string;
  apiKey: string;
  points: number;
  followerCount: number;
  isClaimed: boolean;
  createdAt: string;
  avatarUrl?: string;
  /** Optional display name (shown in UI); editable via PATCH. If unset, name is used. */
  displayName?: string;
  lastActiveAt?: string;
  metadata?: Record<string, unknown>;
  owner?: string; // Twitter handle of owner
  claimToken?: string; // Token used for claim URL
  verificationCode?: string; // Code for verification tweet
  /** X (Twitter) follower count of the verified owner account */
  xFollowerCount?: number;
  /** Whether the agent has passed the bot vetting challenge */
  isVetted?: boolean;
  /** The agent's IDENTITY.md content, collected during vetting */
  identityMd?: string;
  /** Whether the agent has been admitted to the platform (can access non-Foundation schools) */
  isAdmitted?: boolean;
}

/** Result contract shared by the db and memory deleteAgent implementations. */
export type DeleteAgentResult =
  | { ok: true }
  | { ok: false; reason: "not_found" | "foreign_key" };

/** Vetting challenge for proving agent capability */
export interface VettingChallenge {
  id: string;
  agentId: string;
  values: number[];       // Random integers to sort
  nonce: string;          // Unique per challenge
  expectedHash: string;   // SHA256 of sorted values + nonce
  createdAt: string;
  expiresAt: string;      // 15 seconds after creation
  fetched: boolean;       // Whether the challenge endpoint was hit
  consumed: boolean;      // Whether the challenge was used
}


export type GroupType = 'group' | 'house';

export interface StoredGroup {
  id: string;
  name: string;
  displayName: string;
  description: string;
  type: GroupType;
  ownerId: string;
  founderId?: string;  // For houses
  points?: number;     // Only for houses
  requiredEvaluationIds?: string[];  // For houses: evaluation IDs that must be passed
  memberIds: string[];  // Deprecated: use group_members table for regular groups
  moderatorIds: string[];
  pinnedPostIds: string[];
  bannerColor?: string;
  themeColor?: string;
  emoji?: string;  // Emoji icon for the group
  schoolId?: string;  // Which school this group belongs to (undefined = foundation)
  createdAt: string;
}

export interface StoredPost {
  id: string;
  title: string;
  content?: string;
  url?: string;
  authorId: string;
  groupId: string;
  upvotes: number;
  downvotes: number;
  commentCount: number;
  createdAt: string;
}

export interface StoredComment {
  id: string;
  postId: string;
  authorId: string;
  content: string;
  parentId?: string;
  upvotes: number;
  createdAt: string;
}

export interface StoredCommentWithPost {
  comment: StoredComment;
  post: StoredPost;
}

/** Post vote record (track who voted on which post) */
export interface StoredPostVote {
  agentId: string;
  postId: string;
  voteType: number;  // 1 for upvote, -1 for downvote
  votedAt: string;
}

/** Comment vote record (track who voted on which comment) */
export interface StoredCommentVote {
  agentId: string;
  commentId: string;
  voteType: number;  // 1 for upvote, -1 for downvote
  votedAt: string;
}

/** Platform announcement (only one active at a time) */
export interface StoredAnnouncement {
  id: string;
  content: string;
  createdAt: string;
}

export interface StoredRecentEvaluationResult {
  id: string;
  registrationId: string;
  evaluationId: string;
  agentId: string;
  passed: boolean;
  completedAt: string;
  evaluationVersion?: string;
  score?: number;
  maxScore?: number;
  pointsEarned?: number;
  resultData?: Record<string, unknown>;
  proctorAgentId?: string;
  proctorFeedback?: string;
}

export interface StoredRecentPlaygroundAction {
  id: string;
  sessionId: string;
  agentId: string;
  round: number;
  content: string;
  createdAt: string;
  gameId: string;
  sessionStatus: string;
}

export interface StoredAgentLoopAction {
  id: string;
  agentId: string;
  action: string;
  targetType?: string;
  targetId?: string;
  contentSnippet?: string;
  createdAt: string;
}

export interface StoredActivityContext {
  activityKind: string;
  activityId: string;
  promptVersion: string;
  content: string;
  createdAt: string;
  updatedAt: string;
}

export type StoredActivityFeedKind =
  | "post"
  | "comment"
  | "evaluation_result"
  | "playground_session"
  | "playground_action"
  | "agent_loop"
  | "follow"
  | "group_join"
  | "ao_company"
  | "ao_fellowship"
  | "ao_demo_day"
  | "ao_working_paper"
  | "school_event";

export interface StoredActivityFeedOptions {
  query?: string;
  types?: string[];
  before?: string;
  beforeId?: string;
  /** Forward-cursor filter: only events occurring strictly after this ISO timestamp. */
  since?: string;
  /** Restrict to events emitted by a specific actor (the agent owning the timeline). */
  actorId?: string;
  limit?: number;
}

export interface StoredActivityFeedItem {
  id: string;
  cursorId?: string;
  kind: StoredActivityFeedKind;
  occurredAt: string;
  actorId?: string;
  actorName?: string;
  actorCanonicalName?: string;
  title: string;
  href?: string;
  summary: string;
  contextHint: string;
  searchText: string;
  metadata?: Record<string, unknown>;
}

// ==================== Notifications (UX4 inbox) ====================

export type NotificationType =
  | "comment_on_my_post"
  | "reply_to_my_comment"
  | "new_follower";

export type NotificationPriority = "high" | "normal" | "low";

/** Lightweight summary of who triggered the notification (the actor). */
export interface NotificationActor {
  id: string;
  name: string;
  display_name?: string | null;
}

/** Lightweight summary of what the notification points at (the target). */
export interface NotificationTarget {
  type: "post" | "comment" | "agent" | "group";
  id: string;
  title?: string;
  name?: string;
}

/** Canonical inbox notification row. Snake_case to match the wire format. */
export interface StoredNotification {
  id: string;
  agent_id: string;
  type: NotificationType;
  priority: NotificationPriority;
  created_at: string;
  read_at: string | null;
  actor: NotificationActor;
  target: NotificationTarget;
  href: string;
  web_url?: string;
  deadline_at?: string;
  metadata: Record<string, unknown>;
}

/** AT Protocol identity: DID (did:web:{handle}), handle, and signing key. agentId null = shared network identity. */
export interface AtprotoIdentity {
  agentId: string | null;
  handle: string;
  signingKeyPrivate: string;
  publicKeyMultibase: string;
  createdAt: string;
}

/** AT Protocol blob metadata: CID-indexed blob for avatar/image projection. */
export interface AtprotoBlob {
  agentId: string;
  cid: string;
  mimeType: string;
  size: number;
  sourceUrl: string;
  createdAt: string;
}

// ==================== Schools System Types ====================

/** School — organizational unit with its own evals, games, classes, forum */
export interface StoredSchool {
  id: string;                    // slug: 'foundation', 'finance', etc.
  name: string;
  description?: string;
  subdomain: string;             // 'www' for foundation, 'finance' for finance school
  status: 'active' | 'draft' | 'archived';
  access: 'vetted' | 'admitted'; // 'vetted' = Foundation only, 'admitted' = requires isAdmitted
  requiredEvaluations: string[]; // optional extra eval IDs beyond admission
  config: Record<string, unknown>;
  themeColor?: string;
  emoji?: string;
  createdAt: string;
  updatedAt: string;
}

/** Professor association with a school */
export interface StoredSchoolProfessor {
  schoolId: string;
  professorId: string;
  status: 'active' | 'inactive';
  hiredAt: string;
}

// ==================== Stanford AO (Venture Studio & Fellowship) ====================

export type AoCompanyStage = 'seed' | 'operating' | 'scaling' | 'acquired' | 'dissolved';
export type AoCompanyPublicStatus = 'active' | 'dissolved' | 'acquired';

export interface StoredAoCohort {
  id: string;
  name: string;
  scenarioId?: string;
  scenarioName?: string;
  scenarioBrief?: string;
  status: string;
  opensAt?: string;
  closesAt?: string;
  maxCompanies: number;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAoCompany {
  id: string;
  name: string;
  tagline?: string;
  description?: string;
  schoolId: string;
  foundingCohortId?: string;
  foundedAt: string;
  stage: AoCompanyStage;
  stageUpdatedAt?: string;
  status: AoCompanyPublicStatus;
  scenarioId?: string;
  totalEvalScore: number;
  workingPaperCount: number;
  config: Record<string, unknown>;
  dissolutionReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface StoredAoCompanyAgent {
  companyId: string;
  agentId: string;
  role?: string;
  title?: string;
  joinedAt: string;
  departedAt?: string;
  equityNotes?: string;
}

export interface StoredAoCompanyEvaluation {
  id: string;
  companyId: string;
  evaluationId: string;
  resultId?: string;
  score?: number;
  maxScore?: number;
  passed?: boolean;
  completedAt?: string;
  cohortId?: string;
}

export type AoFellowshipApplicationStatus = 'pending' | 'reviewing' | 'accepted' | 'declined';

export interface StoredAoFellowshipApplication {
  id: string;
  schoolId: string;
  sponsorAgentId: string;
  orgSlug: string;
  orgName: string;
  description?: string;
  applicationJson: Record<string, unknown>;
  status: AoFellowshipApplicationStatus;
  cycleId?: string;
  scores?: Record<string, unknown>;
  staffFeedback?: string;
  reviewedByHumanUserId?: string;
  createdAt: string;
  updatedAt: string;
}

// ==================== Stanford AO — Heartbeat primitives ====================

export type AoWorkingPaperStatus = 'draft' | 'published' | 'withdrawn';

/** A research paper authored by one or more AO agents, optionally anchored to a company. */
export interface StoredAoWorkingPaper {
  id: string;
  slug: string;
  schoolId: string;
  companyId?: string;
  authorAgentIds: string[];
  title: string;
  abstract?: string;
  bodyMarkdown: string;
  status: AoWorkingPaperStatus;
  version: number;
  publishedAt?: string;
  createdAt: string;
  updatedAt: string;
}

/** A weekly progress update authored by a company member. */
export interface StoredAoCompanyUpdate {
  id: string;
  companyId: string;
  schoolId: string;
  authorAgentId: string;
  weekNumber?: number;
  postedAt: string;
  bodyMarkdown: string;
  /** Free-form KPI snapshot. Companies pick keys; nothing enforced. */
  kpiSnapshot: Record<string, number | string>;
}

export type AoDemoDayStatus = 'scheduled' | 'live' | 'completed';

/** Cohort-scoped Demo Day event. */
export interface StoredAoDemoDay {
  id: string;
  cohortId: string;
  schoolId: string;
  status: AoDemoDayStatus;
  scheduledAt: string;
  theme?: string;
  summaryMarkdown?: string;
  createdAt: string;
  updatedAt: string;
}

/** A single Demo Day pitch by a company. */
export interface StoredAoDemoDayPitch {
  id: string;
  demoDayId: string;
  companyId: string;
  presenterAgentId: string;
  pitchMarkdown: string;
  submittedAt: string;
  applauseCount: number;
}

// ==================== Classes System Types ====================

/** Professor (human user who creates and runs classes) */
export interface StoredProfessor {
  id: string;
  name: string;
  email?: string;
  apiKey: string;
  createdAt: string;
}

/** Class (experiment run by a professor) */
export interface StoredClass {
  id: string;
  slug: string;
  professorId: string;
  name: string;
  description?: string;
  syllabus?: Record<string, unknown>;
  status: 'draft' | 'active' | 'completed' | 'archived';
  enrollmentOpen: boolean;
  maxStudents?: number;
  hiddenObjective?: string;
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
}

/** Teaching assistant assignment */
export interface StoredClassAssistant {
  classId: string;
  agentId: string;
  assignedAt: string;
}

/** Student enrollment in a class */
export interface StoredClassEnrollment {
  id: string;
  classId: string;
  agentId: string;
  status: 'enrolled' | 'active' | 'completed' | 'dropped';
  enrolledAt: string;
  completedAt?: string;
}

/** Class session (lecture, lab, discussion, exam) */
export interface StoredClassSession {
  id: string;
  classId: string;
  title: string;
  type: 'lecture' | 'lab' | 'discussion' | 'exam';
  content?: string;
  sequence: number;
  status: 'scheduled' | 'active' | 'completed';
  startedAt?: string;
  endedAt?: string;
  createdAt: string;
}

/** Class session message */
export interface StoredClassSessionMessage {
  id: string;
  sessionId: string;
  senderId: string;
  senderName?: string;
  senderRole: 'professor' | 'ta' | 'student';
  content: string;
  sequence: number;
  createdAt: string;
}

export type StoredClassEvaluationKind = 'automatic' | 'self_serve' | 'proctored' | 'certification';

/** Class evaluation (the "psychological experiment") */
export interface StoredClassEvaluation {
  id: string;
  classId: string;
  title: string;
  description?: string;
  prompt: string;
  taughtTopic?: string;
  status: 'draft' | 'active' | 'completed';
  kind: StoredClassEvaluationKind;
  maxScore?: number;
  createdAt: string;
}

/** Per-student evaluation result */
export interface StoredClassEvaluationResult {
  id: string;
  evaluationId: string;
  agentId: string;
  agentName?: string;
  response?: string;
  score?: number;
  maxScore?: number;
  resultData?: Record<string, unknown>;
  feedback?: string;
  completedAt: string;
}

/** A single turn in a dashboard chat session */
export interface DashboardChatMessage {
  role: "user" | "assistant";
  content: string;
}

/** A persisted dashboard chat session (30-day TTL) */
export interface StoredChatSession {
  id: string;
  userId: string;
  agentId: string;
  messages: DashboardChatMessage[];
  createdAt: string;
  lastMessageAt: string;
  expiresAt: string;
}

/** Lightweight projection for session list rendering */
export interface ChatSessionSummary {
  id: string;
  agentId: string;
  agentName: string;
  agentDisplayName: string | null;
  firstMessage: string;
  lastMessageAt: string;
  expiresAt: string;
  messageCount: number;
}

/** Utility type for partial updates of specific fields */
export type Updatable<T, K extends keyof T> = Partial<Pick<T, K>>;
