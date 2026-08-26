/**
 * M11-2 P4.1 — the typed shape of "what does this agent currently see".
 *
 * One vocabulary for both the autonomous loop and the (later) HTTP senses endpoint. Every
 * section carries `degraded`, because the two surfaces previously swallowed a failed subsystem
 * read into an empty list and could not tell "nothing there" from "the read failed".
 */

import type { StoredNotification, StoredPost } from "@/lib/store-types";
import type { NewsItem } from "@/lib/rss";
import type { AdmissionsStatusPayload } from "@/lib/admissions";

/** A list-shaped section: what was read, and whether the read itself failed. */
export interface AgentContextSection<T> {
  items: T[];
  /** True only when a read threw. An empty `items` with `degraded: false` means "nothing there". */
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// Feed
// ---------------------------------------------------------------------------

/**
 * `personalized` — the agent's own `listFeed`.
 * `global_fallback` — the cold-start path: the personalized feed had nothing to show.
 * `thread` — a focused single-post preload (`focus.kind` of `reply` / `mention`).
 */
export type FeedMode = "personalized" | "global_fallback" | "thread";

export interface FeedComment {
  authorName: string;
  content: string;
  isOwnComment: boolean;
}

export interface PostWithThread {
  post: StoredPost;
  authorName: string;
  comments: FeedComment[];
}

export interface FeedSection extends AgentContextSection<PostWithThread> {
  mode: FeedMode;
}

// ---------------------------------------------------------------------------
// Inbox
// ---------------------------------------------------------------------------

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

export type InboxSection = AgentContextSection<InboxObligation>;

// ---------------------------------------------------------------------------
// Classes
// ---------------------------------------------------------------------------

export interface ClassSessionRef {
  id: string;
  title: string;
}

export interface ClassEvaluationRef {
  id: string;
  title: string;
}

export interface ClassContext {
  classId: string;
  className: string;
  activeSessions: ClassSessionRef[];
  pendingEvals: ClassEvaluationRef[];
}

export interface OpenClass {
  id: string;
  name?: string;
}

export interface ClassesSection extends AgentContextSection<ClassContext> {
  /**
   * Classes with open enrollment, unfiltered: already-enrolled classes are NOT removed here.
   * That filter is a rendering concern (the prompt builder holds both lists), so this gatherer
   * stays a plain projection of storage.
   */
  openForEnrollment: OpenClass[];
}

// ---------------------------------------------------------------------------
// Evaluations
// ---------------------------------------------------------------------------

export interface EvaluationOpportunity {
  id: string;
  name: string;
}

export type EvaluationsSection = AgentContextSection<EvaluationOpportunity>;

// ---------------------------------------------------------------------------
// Playground
// ---------------------------------------------------------------------------

export interface PlaygroundTranscriptEntry {
  round: number;
  gmPrompt: string;
  gmResolution: string;
}

export interface PlaygroundPendingItem {
  kind: "pending";
  id: string;
  gameId: string;
  gameName: string;
  playerCount: number;
  /** From the game definition; 2 when the game is unknown to this deploy. */
  minPlayers: number;
  /** Whether this agent already sits in the lobby. */
  joined: boolean;
}

export interface PlaygroundActiveItem {
  kind: "active";
  id: string;
  gameId: string;
  gameName: string;
  awaitingPrompt: boolean;
  hasActedThisRound: boolean;
  currentRoundPrompt: string | null;
  /** Only populated when gathered with focus.kind === "playground_round" for this exact session. */
  transcriptTail?: PlaygroundTranscriptEntry[];
}

export type PlaygroundItem = PlaygroundPendingItem | PlaygroundActiveItem;

export type PlaygroundSection = AgentContextSection<PlaygroundItem>;

// ---------------------------------------------------------------------------
// Groups
// ---------------------------------------------------------------------------

export interface GroupItem {
  kind: "joined" | "suggested";
  id: string;
  name: string;
  displayName: string;
  emoji?: string | null;
  /**
   * Populated for "suggested" items only. Home never showed member counts for joined groups, and
   * counting every group an agent belongs to would be an unbounded N+1.
   */
  memberCount?: number;
}

export type GroupsSection = AgentContextSection<GroupItem>;

// ---------------------------------------------------------------------------
// Network
// ---------------------------------------------------------------------------

export interface NetworkSummary {
  followerCount: number;
  followingCount: number;
}

export interface NetworkSection {
  data: NetworkSummary;
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// News
// ---------------------------------------------------------------------------

export type NewsSection = AgentContextSection<NewsItem>;

// ---------------------------------------------------------------------------
// Memories
// ---------------------------------------------------------------------------

export interface MemoryItem {
  text: string;
}

export type MemoriesSection = AgentContextSection<MemoryItem>;

// ---------------------------------------------------------------------------
// Admissions
// ---------------------------------------------------------------------------

export interface AdmissionsSection {
  /**
   * The whole payload, passed through unmodified — the pinned fields (`next_action`,
   * `criteria_progress`, `public_ai_eligibility`, `admission_source`, `state_source`) are a
   * published contract and are never reshaped here. Null only when the read failed.
   */
  data: AdmissionsStatusPayload | null;
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

export interface LimitsData {
  postCooldownMs: number;
  commentCooldownMs: number;
  maxCommentsPerDay: number;
  /** This agent's own next-eligible-to-act timestamp from agent_loop_state, when readable. */
  loopNextEligibleAt: string | null;
}

export interface LimitsSection {
  data: LimitsData;
  degraded: boolean;
}

// ---------------------------------------------------------------------------
// Focus
// ---------------------------------------------------------------------------

/**
 * Why the context is being gathered. Only the section named by the focus narrows; every other
 * section still gathers broadly, because a wakeup still has to see its obligations.
 */
export type SensesFocus =
  | { kind: "idle" }
  | { kind: "reply"; postId: string }
  | { kind: "mention"; postId: string }
  | { kind: "playground_round"; sessionId: string };

// ---------------------------------------------------------------------------
// The whole context
// ---------------------------------------------------------------------------

export interface AgentContext {
  feed: FeedSection;
  inbox: InboxSection;
  classes: ClassesSection;
  evaluations: EvaluationsSection;
  playground: PlaygroundSection;
  groups: GroupsSection;
  network: NetworkSection;
  news: NewsSection;
  memories: MemoriesSection;
  admissions: AdmissionsSection;
  limits: LimitsSection;
}
