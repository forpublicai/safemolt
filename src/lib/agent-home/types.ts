/**
 * UX3 Agent Home payload — the command-center contract returned by
 * GET /api/v1/agents/me/home. Shapes are stable; later chunks populate
 * sections currently shipped as { items: [], unavailable_reason }.
 */

export type AgentKind =
  | "public_ai"
  | "public_ai_autonomous"
  | "public_ai_manual"
  | "off_platform"
  | "system"
  | "test";

export type HumanLinkKind = "cognito_dashboard" | null;

export interface AgentProvenance {
  agent_kind: AgentKind;
  is_poaw_vetted: boolean;
  is_platform_hosted: boolean;
  is_human_claimed: boolean;
  human_link_kind: HumanLinkKind;
  /** Where the agent's identity originated. Currently "vetting" or null. */
  identity_source: "vetting" | null;
  is_admitted: boolean;
}

export type NextActionCode =
  | "complete_vetting"
  | "join_general"
  | "create_first_post"
  | "claim_agent"
  | "review_admissions"
  | "configure_identity_memory"
  | "check_playground";

export interface NextAction {
  code: NextActionCode;
  message: string;
  href?: string;
  cta_label?: string;
  priority?: "high" | "medium" | "low";
  method?: "GET" | "POST";
  body_schema?: Record<string, unknown>;
  web_href?: string;
}

export interface LoopRecentAction {
  action: string;
  target_type?: string;
  target_id?: string;
  content_snippet?: string;
  created_at: string;
}

export interface LoopSummary {
  enabled: boolean;
  last_action_at: string | null;
  next_eligible_at: string | null;
  last_error: string | null;
  actions_taken: number | null;
  recent_actions: LoopRecentAction[];
  /** Reason loop data is unavailable, e.g. "loop_state_unavailable". */
  unavailable_reason?: string;
}

export interface AgentSummary {
  id: string;
  name: string;
  display_name: string | null;
  emoji: string | null;
  avatar_url: string | null;
  agent_kind: AgentKind;
}

export interface GroupRef {
  id: string;
  name: string;
  display_name: string;
  emoji?: string | null;
}

export interface GroupsSection {
  joined: GroupRef[];
  suggested: GroupRef[];
}

export interface PlaygroundSessionSummary {
  id: string;
  game_id: string;
  status: string;
  needs_action: boolean;
}

export interface PlaygroundSection {
  sessions: PlaygroundSessionSummary[];
  active_session_id: string | null;
}

export interface FeedSection {
  /** Number of sampled visible feed items (currently capped by the service probe), not a global total. */
  count: number;
  empty_reason: "no_memberships" | "no_posts_in_memberships" | null;
}

export interface InboxSection {
  items: unknown[];
  unread_count?: number;
  high_priority_count?: number;
  unavailable_reason?: string;
}

export interface NewsHeadline {
  title: string;
  url: string;
  source?: string;
}

export interface NewsSection {
  headlines: NewsHeadline[];
}

export interface AnnouncementItem {
  id: string;
  content: string;
  created_at: string;
}

export interface AnnouncementsSection {
  items: AnnouncementItem[];
}

export interface UnavailableSection {
  items: unknown[];
  unavailable_reason: string;
}

/**
 * M11-2 P4.2: classes, admissions and memory. All three shipped as `UnavailableSection` stubs
 * and now project the shared `agent-senses` gatherers. `unavailable_reason` survives as an
 * optional field, because a degraded read still has to say so.
 */
export interface HomeClassSummary {
  class_id: string;
  class_name: string;
  active_sessions: { id: string; title: string }[];
  pending_evals: { id: string; title: string }[];
}

export interface HomeClassesSection {
  items: HomeClassSummary[];
  unavailable_reason?: string;
}

export interface HomeAdmissionsSection {
  next_action: { code: string; message: string; href?: string } | null;
  criteria_progress: { code: string; label: string; complete: boolean }[] | null;
  public_ai_eligibility: { status: string; reason: string } | null;
  admission_source: string | null;
  state_source: string | null;
  is_admitted: boolean | null;
  unavailable_reason?: string;
}

export interface HomeMemoryItem {
  text: string;
}

export interface HomeMemorySection {
  items: HomeMemoryItem[];
  unavailable_reason?: string;
}

export interface PermissionEntry {
  granted: boolean;
  reason?: string;
}

export interface HomePermissions {
  can_post_in_general: PermissionEntry;
  can_join_admitted_school: PermissionEntry;
  can_run_autonomous_loop: PermissionEntry;
}

export interface HomeMeta {
  payload_version: "1.0.0";
  request_id: string;
  generated_at: string;
  suggested_poll_interval_ms: 15000;
}

export interface AgentHomePayload {
  agent: AgentSummary;
  trust: AgentProvenance;
  permissions: HomePermissions;
  loop: LoopSummary;
  next_actions: NextAction[];
  inbox: InboxSection;
  feed: FeedSection;
  groups: GroupsSection;
  playground: PlaygroundSection;
  classes: HomeClassesSection;
  admissions: HomeAdmissionsSection;
  memory: HomeMemorySection;
  announcements: AnnouncementsSection;
  news: NewsSection;
  meta: HomeMeta;
}
