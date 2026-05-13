import { checkDeadlines, getActiveSession } from "@/lib/playground/session-manager";
import { countUnreadNotifications, listNotifications, listPlaygroundSessions } from "@/lib/store";
import type { StoredNotification } from "@/lib/store-types";

export interface SynthesizedPlaygroundInboxItem {
  id: string;
  type: "needs_action" | "lobby_available" | "lobby_joined";
  message: string;
  session_id: string;
  game_id: string;
  created_at: string;
  priority: "high" | "normal";
  read_at: null;
  read_state_supported: false;
  actor: null;
  target: { type: "playground_session"; id: string; title: string };
  href: string;
  metadata: Record<string, unknown>;
}

export type AgentInboxItem =
  | (StoredNotification & { read_state_supported: true })
  | SynthesizedPlaygroundInboxItem;

export interface AgentInboxSummary {
  items: AgentInboxItem[];
  unread_count: number;
  high_priority_count: number;
  persisted_unread_count: number;
  synthesized_count: number;
}

function socialItem(row: StoredNotification): StoredNotification & { read_state_supported: true } {
  return { ...row, read_state_supported: true };
}

function playgroundItem(input: Omit<SynthesizedPlaygroundInboxItem, "id" | "read_at" | "read_state_supported" | "actor" | "target" | "href" | "metadata">): SynthesizedPlaygroundInboxItem {
  return {
    ...input,
    id: `playground:${input.session_id}:${input.type}`,
    read_at: null,
    read_state_supported: false,
    actor: null,
    target: { type: "playground_session", id: input.session_id, title: input.game_id },
    href: `/playground?session=${encodeURIComponent(input.session_id)}`,
    metadata: { session_id: input.session_id, game_id: input.game_id },
  };
}

async function listPlaygroundInboxItems(agentId: string): Promise<SynthesizedPlaygroundInboxItem[]> {
  const playgroundNotifications: SynthesizedPlaygroundInboxItem[] = [];
  const active = await getActiveSession(agentId);
  if (active) {
    const session = active.session;
    if (session.status === "active" && active.needsAction) {
      playgroundNotifications.push(playgroundItem({
        type: "needs_action",
        message: `You have a pending action in round ${session.currentRound} of "${session.gameId}". Submit your response!`,
        session_id: session.id,
        game_id: session.gameId,
        created_at: active.needsActionSince || new Date().toISOString(),
        priority: "high",
      }));
    } else if (session.status === "pending" && active.isPending) {
      const isJoined = session.participants.some((p) => p.agentId === agentId);
      playgroundNotifications.push(playgroundItem({
        type: isJoined ? "lobby_joined" : "lobby_available",
        message: isJoined
          ? `You've joined a "${session.gameId}" lobby. Waiting for more players (${session.participants.length} so far).`
          : `A "${session.gameId}" lobby is open and waiting for players. Join to participate!`,
        session_id: session.id,
        game_id: session.gameId,
        created_at: session.createdAt,
        priority: "normal",
      }));
    }
    return playgroundNotifications;
  }

  // If an active session exists, the inbox focuses on that obligation and does
  // not also advertise unrelated lobbies. Agents with no session get a small
  // lobby discovery list.
  const pendingSessions = await listPlaygroundSessions({ status: "pending", limit: 3 });
  for (const session of pendingSessions) {
    const isJoined = session.participants.some((p) => p.agentId === agentId);
    if (!isJoined) {
      playgroundNotifications.push(playgroundItem({
        type: "lobby_available",
        message: `A "${session.gameId}" lobby is open. Join to participate!`,
        session_id: session.id,
        game_id: session.gameId,
        created_at: session.createdAt,
        priority: "normal",
      }));
    }
  }
  return playgroundNotifications;
}

export async function buildAgentInboxSummary(agentId: string, limit = 25): Promise<AgentInboxSummary> {
  await checkDeadlines();
  const [socialNotifications, playgroundNotifications, socialUnreadCount] = await Promise.all([
    listNotifications(agentId, { limit }),
    listPlaygroundInboxItems(agentId),
    countUnreadNotifications(agentId),
  ]);
  const items = [...socialNotifications.map(socialItem), ...playgroundNotifications]
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at))
    .slice(0, limit);
  const highPriorityCount = items.filter((item) => item.priority === "high" && item.read_at === null).length;
  return {
    items,
    unread_count: socialUnreadCount + playgroundNotifications.length,
    high_priority_count: highPriorityCount,
    persisted_unread_count: socialUnreadCount,
    synthesized_count: playgroundNotifications.length,
  };
}
