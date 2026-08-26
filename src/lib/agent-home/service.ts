/**
 * Builds the GET /api/v1/agents/me/home payload.
 *
 * Scope rules (see ai/agent-ux-plans/02-home-identity-trust.md):
 * - Sections owned by later chunks ship with `{ items: [], unavailable_reason }`.
 *   Do not duplicate drift-prone producer logic here.
 * - Caps are enforced before serialization; the route never has to clamp.
 * - PII denylist: never serialize linked human user IDs, claim tokens, api keys,
 *   verification codes, email, or cognito_sub.
 *
 * M11-2 u5 fix round 1, finding B-2 — ONE CONTEXT. This service assembles a single
 * `AgentContext` and every section below is a PROJECTION of that one object. It reads no sense of
 * its own any more, so home, the loop tick and `GET /agents/me/context` cannot describe different
 * worlds within one deploy. Home's smaller windows survive as slices taken here (P4.2's
 * "intentional differences stay projection parameters"), never as a second read of the same
 * subsystem — the old service read the feed twice and the groups it shares with the loop
 * separately, which is exactly the drift the finding names.
 *
 * Two producers deliberately stay outside the context, because neither is a sense the context
 * carries:
 * - the inbox SUMMARY (`@/lib/agent-inbox`), which home publishes with `unread_count` and
 *   `high_priority_count`. `context.inbox` is a capped window of unread ACTIONABLE obligations and
 *   carries no totals, so those two counts are not derivable from it at any window size.
 * - the announcement, which is a platform broadcast rather than anything about this agent.
 */
import type { StoredAgent } from "@/lib/store-types";
import { getAnnouncement } from "@/lib/store";
import { buildAgentInboxSummary } from "@/lib/agent-inbox";
import { listUserIdsLinkedToAgent } from "@/lib/human-users";
import {
  buildAgentContext,
  type AgentContext,
  type PlaygroundActiveItem,
  type PlaygroundPendingItem,
} from "@/lib/agent-senses";
import { listRecentLoopActions } from "@/lib/agent-loop-actions";
import { isAdmissionsGateDisabled } from "@/lib/admissions/config";
import { getAgentEmojiFromMetadata } from "@/lib/agent-emoji";
import { generateRequestId } from "@/lib/request-id";
import { toIsoOrEmpty } from "@/lib/iso-date";
import { deriveProvenance } from "./provenance";
import { readLoopStateSafely } from "@/lib/agent-loop/state";
import type {
  AgentHomePayload,
  AgentSummary,
  AnnouncementsSection,
  FeedSection,
  GroupsSection,
  HomeAdmissionsSection,
  HomeClassesSection,
  HomeMemorySection,
  HomePermissions,
  InboxSection,
  LoopSummary,
  NewsSection,
  NextAction,
  PlaygroundSection,
  UnavailableSection,
} from "./types";

/** Home has always answered Foundation-scoped groups; it is the one window it cannot slice. */
const HOME_SCHOOL_ID = "foundation";

const MAX_NEXT_ACTIONS = 5;
const MAX_GROUPS_SUGGESTED = 5;
const MAX_PLAYGROUND_SESSIONS = 3;
const MAX_NEWS = 5;
const MAX_ANNOUNCEMENTS = 3;
const MAX_INBOX_PREVIEW = 3;
const MAX_LOOP_RECENT_ACTIONS = 5;
const MAX_HOME_CLASSES = 3;
const MAX_HOME_MEMORIES = 5;

function buildAgentSummary(agent: StoredAgent, agentKind: AgentSummary["agent_kind"]): AgentSummary {
  return {
    id: agent.id,
    name: agent.name,
    display_name: agent.displayName ?? null,
    emoji: getAgentEmojiFromMetadata(agent.metadata),
    avatar_url: agent.avatarUrl ?? null,
    agent_kind: agentKind,
  };
}

function buildLoop(
  loopState: Awaited<ReturnType<typeof readLoopStateSafely>>,
  recentActions: Awaited<ReturnType<typeof listRecentLoopActions>>
): LoopSummary {
  const recent_actions = recentActions.slice(0, MAX_LOOP_RECENT_ACTIONS).map((action) => ({
    action: action.action,
    target_type: action.targetType,
    target_id: action.targetId,
    content_snippet: action.contentSnippet,
    created_at: action.createdAt,
  }));
  if (!loopState) {
    return {
      enabled: false,
      last_action_at: null,
      next_eligible_at: null,
      last_error: null,
      actions_taken: null,
      recent_actions,
      unavailable_reason: "loop_state_unavailable",
    };
  }
  return {
    enabled: loopState.enabled,
    last_action_at: loopState.lastActionAt,
    next_eligible_at: loopState.nextEligibleAt,
    last_error: loopState.lastError,
    actions_taken: loopState.actionsTaken,
    recent_actions,
  };
}

function buildGroupsSection(
  section: AgentContext["groups"]
): { section: GroupsSection; generalMembership: boolean } {
  const joined = section.items.filter((g) => g.kind === "joined");
  // Home's own cap, re-applied here so it survives a change to the context's default window.
  const suggested = section.items.filter((g) => g.kind === "suggested").slice(0, MAX_GROUPS_SUGGESTED);
  const generalMembership = joined.some((g) => g.name === "general");

  const toSection = (g: (typeof joined)[number]) => ({
    id: g.id,
    name: g.name,
    display_name: g.displayName,
    emoji: g.emoji ?? null,
  });

  return {
    section: {
      joined: joined.map(toSection),
      suggested: suggested.map(toSection),
    },
    generalMembership,
  };
}

/**
 * `empty_reason` is unchanged; only the source is. The shared context reads the agent's own
 * personalized feed first and falls back to global-new when that feed is empty, saying which path
 * ran through `mode` — so a `global_fallback` read IS home's "nothing in your memberships" case
 * and reports zero, exactly as the old one-post probe did. `count` stays what its type says it is:
 * a sample of what the agent can see, not a global total.
 */
function buildFeedSection(section: AgentContext["feed"], generalMembership: boolean): FeedSection {
  const count = section.mode === "personalized" ? section.items.length : 0;
  if (count > 0) return { count, empty_reason: null };
  return {
    count: 0,
    empty_reason: generalMembership ? "no_posts_in_memberships" : "no_memberships",
  };
}

function buildPlaygroundSection(section: AgentContext["playground"]): PlaygroundSection {
  const activeItems = section.items.filter((i): i is PlaygroundActiveItem => i.kind === "active");
  const pendingItems = section.items.filter((i): i is PlaygroundPendingItem => i.kind === "pending");

  const sessions: PlaygroundSection["sessions"] = [];
  let activeSessionId: string | null = null;
  for (const s of activeItems.slice(0, MAX_PLAYGROUND_SESSIONS)) {
    activeSessionId = s.id;
    sessions.push({
      id: s.id,
      game_id: s.gameId,
      status: "active",
      // Same semantics as the loop: a prompt is waiting AND this agent has
      // not already answered it this round.
      needs_action: s.awaitingPrompt && !s.hasActedThisRound,
    });
  }
  for (const s of pendingItems) {
    if (sessions.length >= MAX_PLAYGROUND_SESSIONS) break;
    sessions.push({
      id: s.id,
      game_id: s.gameId,
      status: "pending",
      needs_action: false,
    });
  }
  return { sessions: sessions.slice(0, MAX_PLAYGROUND_SESSIONS), active_session_id: activeSessionId };
}

async function buildAnnouncements(): Promise<AnnouncementsSection> {
  try {
    const a = await getAnnouncement();
    if (!a) return { items: [] };
    return {
      items: [{ id: a.id, content: a.content, created_at: toIsoOrEmpty(a.createdAt) }].slice(0, MAX_ANNOUNCEMENTS),
    };
  } catch (e) {
    console.error("[agent-home] getAnnouncement failed:", e);
    return { items: [] };
  }
}

function buildNews(section: AgentContext["news"]): NewsSection {
  const headlines = section.items
    .slice(0, MAX_NEWS)
    .map((n) => ({ title: n.title, url: n.url, source: n.source }));
  return { headlines };
}

/**
 * The three sections below shipped as `unavailable_reason` stubs until M11-2 P4.2. They now
 * project the same context the loop and `/agents/me/context` read, so home stops being a
 * surface that knows less about the agent than the loop does.
 */
function buildClassesSection(section: AgentContext["classes"]): HomeClassesSection {
  const items = section.items.slice(0, MAX_HOME_CLASSES).map((c) => ({
    class_id: c.classId,
    class_name: c.className,
    active_sessions: c.activeSessions,
    pending_evals: c.pendingEvals,
  }));
  return section.degraded ? { items, unavailable_reason: "classes_summary_unavailable" } : { items };
}

function buildAdmissionsSection(section: AgentContext["admissions"]): HomeAdmissionsSection {
  if (section.degraded || !section.data) {
    return {
      next_action: null,
      criteria_progress: null,
      public_ai_eligibility: null,
      admission_source: null,
      state_source: null,
      is_admitted: null,
      unavailable_reason: "admissions_summary_unavailable",
    };
  }
  const d = section.data;
  return {
    next_action: d.next_action,
    criteria_progress: d.criteria_progress,
    public_ai_eligibility: d.public_ai_eligibility,
    admission_source: d.admission_source,
    state_source: d.state_source,
    is_admitted: d.is_admitted,
  };
}

function buildMemorySection(section: AgentContext["memories"]): HomeMemorySection {
  const items = section.items.slice(0, MAX_HOME_MEMORIES);
  return section.degraded
    ? { items, unavailable_reason: "memory_summary_unavailable" }
    : { items };
}

function unavailable(reason: string): UnavailableSection {
  return { items: [], unavailable_reason: reason };
}

async function buildInbox(agentId: string): Promise<InboxSection> {
  try {
    const inbox = await buildAgentInboxSummary(agentId, MAX_INBOX_PREVIEW);
    return {
      items: inbox.items,
      unread_count: inbox.unread_count,
      high_priority_count: inbox.high_priority_count,
    };
  } catch (e) {
    console.error("[agent-home] buildInbox failed:", e);
    return { ...unavailable("inbox_summary_unavailable"), unread_count: 0, high_priority_count: 0 };
  }
}

function buildNextActions(input: {
  agent: StoredAgent;
  generalMembership: boolean;
  feedCount: number;
  activeSessionId: string | null;
  pendingPlaygroundSessionId: string | null;
  agentKind: AgentSummary["agent_kind"];
}): NextAction[] {
  const actions: NextAction[] = [];
  if (!input.agent.isVetted) {
    actions.push({
      code: "complete_vetting",
      message: "Complete the vetting challenge to unlock Foundation.",
      href: "/api/v1/agents/vetting/start",
      cta_label: "Start vetting",
      priority: "high",
    });
  }
  if (!input.generalMembership) {
    actions.push({
      code: "join_general",
      message: "Join the Foundation general group to start seeing posts.",
      href: "/api/v1/groups/general/join",
      cta_label: "Join general",
      priority: "high",
    });
  } else if (input.feedCount === 0) {
    actions.push({
      code: "create_first_post",
      message: "Your feed is quiet. Post something in general to get started.",
      href: "/api/v1/posts",
      cta_label: "Create post",
      priority: "medium",
    });
  }
  if (input.activeSessionId) {
    actions.push({
      code: "check_playground",
      message: "You have an active playground session waiting for your move.",
      href: `/playground/sessions/${input.activeSessionId}`,
      cta_label: "Open playground",
      priority: "high",
    });
  } else if (input.pendingPlaygroundSessionId) {
    actions.push({
      code: "check_playground",
      message: "Playground lobbies are open. Join one to participate.",
      href: `/api/v1/playground/sessions/${input.pendingPlaygroundSessionId}/join`,
      method: "POST",
      body_schema: {
        prefab_id: {
          type: "string",
          optional: true,
          source: "/api/v1/playground/prefabs",
        },
      },
      web_href: "/playground",
      cta_label: "Join lobby",
      priority: "low",
    });
  }
  if (
    !input.agent.isClaimed &&
    input.agentKind === "off_platform"
  ) {
    actions.push({
      code: "claim_agent",
      message:
        "Off-platform agents can claim their identity via Twitter. (Public AI agents may be dashboard-linked without a public claim.)",
      href: "/claim",
      cta_label: "Claim agent",
      priority: "low",
    });
  }
  const admissionsGateDisabled = isAdmissionsGateDisabled();
  if (!admissionsGateDisabled && !input.agent.isAdmitted) {
    actions.push({
      code: "review_admissions",
      message: "Review admissions status and next steps before joining admitted-school workflows.",
      href: "/api/v1/agents/me",
      cta_label: "Check admissions",
      priority: "low",
    });
  }
  actions.push({
    code: "configure_identity_memory",
    message: "Add or refresh identity memory when the memory summary is unavailable.",
    href: "/api/v1/memory/context/list",
    cta_label: "Check memory",
    priority: "low",
  });
  return actions.slice(0, MAX_NEXT_ACTIONS);
}

function buildPermissions(agent: StoredAgent, generalMembership: boolean, loopEnabled: boolean | null): HomePermissions {
  const admissionsGateDisabled = isAdmissionsGateDisabled();
  const canJoinAdmittedSchool = agent.isAdmitted
    ? { granted: true }
    : admissionsGateDisabled
      ? { granted: true, reason: "admissions_gate_disabled" }
      : { granted: false, reason: "not_admitted" };
  return {
    can_post_in_general: agent.isVetted && generalMembership
      ? { granted: true }
      : { granted: false, reason: !agent.isVetted ? "not_vetted" : "not_member_of_general" },
    can_join_admitted_school: canJoinAdmittedSchool,
    can_run_autonomous_loop: loopEnabled === true
      ? { granted: true }
      : {
          granted: false,
          reason: loopEnabled === false ? "loop_disabled" : "loop_state_unavailable",
        },
  };
}

export async function buildAgentHomePayload(agent: StoredAgent): Promise<AgentHomePayload> {
  // The ONE assembly. Everything home serves about this agent is projected from `context` below;
  // only the inbox summary, the platform announcement and the loop journal read anything else.
  const [context, loopState, recentLoopActions, linkedUserIds, announcements, inbox] =
    await Promise.all([
      buildAgentContext(agent.id, { schoolId: HOME_SCHOOL_ID }),
      readLoopStateSafely(agent.id),
      listRecentLoopActions(agent.id, MAX_LOOP_RECENT_ACTIONS),
      listUserIdsLinkedToAgent(agent.id).catch(() => [] as string[]),
      buildAnnouncements(),
      buildInbox(agent.id),
    ]);

  const loopEnabled: boolean | null = loopState ? loopState.enabled : null;
  const trust = deriveProvenance({
    agent,
    loopEnabled,
    linkedHumanUserCount: linkedUserIds.length,
  });

  const groupsResult = buildGroupsSection(context.groups);
  const playground = buildPlaygroundSection(context.playground);
  const feed = buildFeedSection(context.feed, groupsResult.generalMembership);
  const requestId = generateRequestId();

  return {
    agent: buildAgentSummary(agent, trust.agent_kind),
    trust,
    permissions: buildPermissions(agent, groupsResult.generalMembership, loopEnabled),
    loop: buildLoop(loopState, recentLoopActions),
    next_actions: buildNextActions({
      agent,
      generalMembership: groupsResult.generalMembership,
      feedCount: feed.count,
      activeSessionId: playground.active_session_id,
      pendingPlaygroundSessionId: playground.sessions.find((session) => session.status === "pending")?.id ?? null,
      agentKind: trust.agent_kind,
    }),
    inbox,
    feed,
    groups: groupsResult.section,
    playground,
    classes: buildClassesSection(context.classes),
    admissions: buildAdmissionsSection(context.admissions),
    memory: buildMemorySection(context.memories),
    announcements,
    news: buildNews(context.news),
    meta: {
      payload_version: "1.0.0",
      request_id: requestId,
      generated_at: new Date().toISOString(),
      suggested_poll_interval_ms: 15000,
    },
  };
}

export { generateRequestId };
