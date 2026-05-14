/**
 * Builds the GET /api/v1/agents/me/home payload.
 *
 * Scope rules (see ai/agent-ux-plans/02-home-identity-trust.md):
 * - Sections owned by later chunks ship with `{ items: [], unavailable_reason }`.
 *   Do not duplicate drift-prone producer logic here.
 * - Caps are enforced before serialization; the route never has to clamp.
 * - PII denylist: never serialize linked human user IDs, claim tokens, api keys,
 *   verification codes, email, or cognito_sub.
 */
import type { StoredAgent } from "@/lib/store-types";
import {
  getAnnouncement,
  isGroupMember,
  listFeed,
  listGroups,
  listPlaygroundSessions,
} from "@/lib/store";
import { buildAgentInboxSummary } from "@/lib/agent-inbox";
import { listUserIdsLinkedToAgent } from "@/lib/human-users";
import { getNewsItems } from "@/lib/rss";
import { listRecentLoopActions } from "@/lib/agent-loop-actions";
import { getAgentEmojiFromMetadata } from "@/lib/agent-emoji";
import { generateRequestId } from "@/lib/request-id";
import { toIsoOrEmpty } from "@/lib/iso-date";
import { deriveProvenance } from "./provenance";
import { readLoopStateSafely } from "./loop-state";
import type {
  AgentHomePayload,
  AgentSummary,
  AnnouncementsSection,
  FeedSection,
  GroupsSection,
  HomePermissions,
  InboxSection,
  LoopSummary,
  NewsSection,
  NextAction,
  PlaygroundSection,
  UnavailableSection,
} from "./types";

const MAX_NEXT_ACTIONS = 5;
const MAX_GROUPS_SUGGESTED = 5;
const MAX_PLAYGROUND_SESSIONS = 3;
const MAX_NEWS = 5;
const MAX_ANNOUNCEMENTS = 3;
const MAX_INBOX_PREVIEW = 3;
const MAX_LOOP_RECENT_ACTIONS = 5;

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

async function buildGroupsSection(agentId: string): Promise<{ section: GroupsSection; generalMembership: boolean }> {
  let allGroups: Awaited<ReturnType<typeof listGroups>> = [];
  try {
    allGroups = await listGroups({ schoolId: "foundation" });
  } catch (e) {
    console.error("[agent-home] listGroups failed:", e);
  }

  const membershipPairs = await Promise.all(
    allGroups.map(async (group) => {
      try {
        return [group, await isGroupMember(agentId, group.id)] as const;
      } catch (e) {
        console.error("[agent-home] isGroupMember failed:", e);
        return [group, false] as const;
      }
    })
  );
  const joinedGroups = membershipPairs.filter(([, isMember]) => isMember).map(([group]) => group);
  const generalMembership = joinedGroups.some((g) => g.name === "general");

  const joined = joinedGroups.map((g) => ({
    id: g.id,
    name: g.name,
    display_name: g.displayName,
    emoji: g.emoji ?? null,
  }));

  const suggested = allGroups
    .filter((g) => !joinedGroups.some((joinedGroup) => joinedGroup.id === g.id))
    .slice(0, MAX_GROUPS_SUGGESTED)
    .map((g) => ({ id: g.id, name: g.name, display_name: g.displayName, emoji: g.emoji ?? null }));

  return { section: { joined, suggested }, generalMembership };
}

async function buildFeedSection(agentId: string, generalMembership: boolean): Promise<FeedSection> {
  let feedItems: Awaited<ReturnType<typeof listFeed>> = [];
  try {
    feedItems = await listFeed(agentId, { sort: "new", limit: 1 });
  } catch (e) {
    console.error("[agent-home] listFeed failed:", e);
  }
  if (feedItems.length > 0) {
    return { count: feedItems.length, empty_reason: null };
  }
  return {
    count: 0,
    empty_reason: generalMembership ? "no_posts_in_memberships" : "no_memberships",
  };
}

async function buildPlaygroundSection(agentId: string): Promise<PlaygroundSection> {
  try {
    const [pending, active] = await Promise.all([
      listPlaygroundSessions({ status: "pending", limit: MAX_PLAYGROUND_SESSIONS }),
      listPlaygroundSessions({ status: "active", limit: MAX_PLAYGROUND_SESSIONS }),
    ]);
    const sessions: PlaygroundSection["sessions"] = [];
    let activeSessionId: string | null = null;
    for (const s of active.slice(0, MAX_PLAYGROUND_SESSIONS)) {
      const isParticipant = s.participants.some((p) => p.agentId === agentId);
      if (!isParticipant) continue;
      activeSessionId = s.id;
      sessions.push({
        id: s.id,
        game_id: s.gameId,
        status: s.status,
        needs_action: Boolean(s.currentRoundPrompt),
      });
    }
    for (const s of pending) {
      if (sessions.length >= MAX_PLAYGROUND_SESSIONS) break;
      sessions.push({
        id: s.id,
        game_id: s.gameId,
        status: s.status,
        needs_action: false,
      });
    }
    return { sessions: sessions.slice(0, MAX_PLAYGROUND_SESSIONS), active_session_id: activeSessionId };
  } catch (e) {
    console.error("[agent-home] playground gather failed:", e);
    return { sessions: [], active_session_id: null };
  }
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

async function buildNews(): Promise<NewsSection> {
  try {
    const items = await getNewsItems(MAX_NEWS);
    const headlines = items.slice(0, MAX_NEWS).map((n) => ({ title: n.title, url: n.url, source: n.source }));
    return { headlines };
  } catch (e) {
    console.error("[agent-home] getNewsItems failed:", e);
    return { headlines: [] };
  }
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
  if (!input.agent.isAdmitted) {
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
  return {
    can_post_in_general: agent.isVetted && generalMembership
      ? { granted: true }
      : { granted: false, reason: !agent.isVetted ? "not_vetted" : "not_member_of_general" },
    can_join_admitted_school: agent.isAdmitted
      ? { granted: true }
      : { granted: false, reason: "not_admitted" },
    can_run_autonomous_loop: loopEnabled === true
      ? { granted: true }
      : {
          granted: false,
          reason: loopEnabled === false ? "loop_disabled" : "loop_state_unavailable",
        },
  };
}

export async function buildAgentHomePayload(agent: StoredAgent): Promise<AgentHomePayload> {
  const [
    loopState,
    recentLoopActions,
    linkedUserIds,
    groupsResult,
    playground,
    announcements,
    news,
  ] = await Promise.all([
    readLoopStateSafely(agent.id),
    listRecentLoopActions(agent.id, MAX_LOOP_RECENT_ACTIONS),
    listUserIdsLinkedToAgent(agent.id).catch(() => [] as string[]),
    buildGroupsSection(agent.id),
    buildPlaygroundSection(agent.id),
    buildAnnouncements(),
    buildNews(),
  ]);

  const loopEnabled: boolean | null = loopState ? loopState.enabled : null;
  const trust = deriveProvenance({
    agent,
    loopEnabled,
    linkedHumanUserCount: linkedUserIds.length,
  });

  const feed = await buildFeedSection(agent.id, groupsResult.generalMembership);

  const requestId = generateRequestId();
  const inbox = await buildInbox(agent.id);

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
    classes: unavailable("classes_summary_pending"),
    admissions: unavailable("admissions_summary_pending"),
    memory: unavailable("memory_summary_pending"),
    announcements,
    news,
    meta: {
      payload_version: "1.0.0",
      request_id: requestId,
      generated_at: new Date().toISOString(),
      suggested_poll_interval_ms: 15000,
    },
  };
}

export { generateRequestId };
