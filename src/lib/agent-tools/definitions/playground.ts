/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * against the internal store (no HTTP round-trips).
 */

import {
  listPlaygroundSessions,
  getPlaygroundSession,
  getPlaygroundActions,
} from "@/lib/store";
import { joinSession, submitAction } from "@/lib/playground/session-manager";
import { getSchoolGameById, listGames } from "@/lib/playground/games";
import { sessionSchoolAccessDenial } from "@/lib/school-context";
import type { PlaygroundSession, SessionStatus } from "@/lib/playground/types";
import type { StoredAgent } from "@/lib/store-types";
import type { ToolCallResult, ToolDefinition, ToolExecutor } from "../types";

export const definitions: ToolDefinition[] = [
{
    type: "function",
    function: {
      name: "list_playground_games",
      description: "List available playground games/simulations.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_playground_sessions",
      description: "List playground sessions. Shows pending sessions you can join and active ones.",
      parameters: {
        type: "object",
        properties: {
          status: { type: "string", enum: ["pending", "active", "completed"], description: "Filter by status (default: pending)" },
        },
      },
    },
  },
  {
    type: "function",
    targetType: "playground",
    function: {
      name: "join_playground_session",
      description: "Join a pending playground session to participate in the simulation/game.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string", description: "Playground session ID to join" } },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_playground_session",
      description: "Get details about a specific playground session.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string", description: "Session ID" } },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    targetType: "playground",
    function: {
      name: "submit_playground_action",
      description: "Submit your action for the current round in a playground session.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID" },
          content: { type: "string", description: "Your action/response for this round" },
        },
        required: ["session_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_playground_actions",
      description: "Get actions from a specific round of a playground session.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID" },
          round: { type: "number", description: "Round number" },
        },
        required: ["session_id", "round"],
      },
    },
  },
];

function summarizeJoinResult(
  sessionId: string,
  session: PlaygroundSession,
  alreadyJoined: boolean
): ToolCallResult {
  return {
    success: true,
    data: {
      session_id: sessionId,
      joined: true,
      already_joined: alreadyJoined,
      status: session.status,
      participants: session.participants?.length ?? 0,
    },
  };
}

function joinErrorCode(message: string): string {
  if (message === "Session full") return "session_full";
  if (message === "Session not found") return "session_not_found";
  if (message === "Agent not found") return "agent_not_found";
  if (message === "Game definition not found") return "game_not_found";
  if (message === "invalid_prefab_id") return "invalid_prefab_id";
  if (message === "Session is not in pending state" || message === "Session not pending") {
    return "session_not_pending";
  }
  return "join_failed";
}

async function formatJoinFailure(
  sessionId: string,
  agentId: string,
  message: string
): Promise<ToolCallResult> {
  const session = await getPlaygroundSession(sessionId);
  const participantCount = session?.participants?.length ?? 0;
  const alreadyJoined = Boolean(session?.participants?.some((p) => p.agentId === agentId));

  if (alreadyJoined && session) {
    return summarizeJoinResult(sessionId, session, true);
  }

  return {
    success: false,
    error: message,
    data: {
      code: joinErrorCode(message),
      session_id: sessionId,
      status: session?.status ?? null,
      participants: participantCount,
    },
  };
}

/**
 * The session's own school decides who may take part — on the tool surface too.
 *
 * The REST join route has carried this gate since C20 review round 5, but the tools call
 * `joinSession`/`submitAction` straight through, so the route's check never ran for them: a
 * Foundation-vetted, AO-unadmitted agent could name an AO session from the dashboard and both join
 * it and submit an action, and an action is what schedules billed GM inference. Reads stay open,
 * matching the REST surface; only the two mutating verbs gate.
 *
 * Absence is not this helper's to report — the caller's own not-found branch already does that,
 * and answering "denied" for a nonexistent id would leak which ids exist.
 */
async function playgroundSessionDenial(
  agent: StoredAgent,
  sessionId: string
): Promise<ToolCallResult | null> {
  const session = await getPlaygroundSession(sessionId);
  if (!session) return null;
  const denial = sessionSchoolAccessDenial(agent, session);
  return denial ? { success: false, error: denial.error, data: { code: denial.code } } : null;
}

export const executors: Record<string, ToolExecutor> = {
  list_playground_games: async (args, { agent }) => {
    const games = listGames();
    return {
      success: true,
      data: {
        games: games.map((g) => ({
          id: g.id,
          name: g.name,
          description: g.description?.slice(0, 150),
          min_players: g.minPlayers,
          max_players: g.maxPlayers,
          max_rounds: g.defaultMaxRounds,
        })),
      },
    };
  },

  list_playground_sessions: async (args, { agent }) => {
    const status = (args.status as SessionStatus) || "pending";
    const sessions = await listPlaygroundSessions({ status, limit: 10 });
    return {
      success: true,
      data: {
        sessions: sessions.map((s) => {
          const game = getSchoolGameById(s.schoolId ?? "foundation", s.gameId);
          return {
            id: s.id,
            game_id: s.gameId,
            game_name: game?.name ?? s.gameId,
            status: s.status,
            participants: s.participants?.length ?? 0,
            max_players: game?.maxPlayers ?? null,
            current_round: s.currentRound,
            created_at: s.createdAt,
          };
        }),
      },
    };
  },

  join_playground_session: async (args, { agent }) => {
    const sessionId = String(args.session_id);
    const denial = await playgroundSessionDenial(agent, sessionId);
    if (denial) return denial;
    try {
      const session = await joinSession(sessionId, agent.id);
      return summarizeJoinResult(sessionId, session, false);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to join session";
      return formatJoinFailure(sessionId, agent.id, message);
    }
  },

  get_playground_session: async (args, { agent }) => {
    const session = await getPlaygroundSession(String(args.session_id));
    if (!session) return { success: false, error: "Session not found" };
    const game = getSchoolGameById(session.schoolId ?? "foundation", session.gameId);
    return {
      success: true,
      data: {
        id: session.id,
        game_name: game?.name ?? session.gameId,
        status: session.status,
        current_round: session.currentRound,
        max_rounds: session.maxRounds,
        participants: session.participants?.map((p) => ({ name: p.agentName, status: p.status })),
        round_deadline: session.roundDeadline,
      },
    };
  },

  submit_playground_action: async (args, { agent }) => {
    // M11-1 C12: delegate to submitAction — the same path the route uses. The pre-C12 tool
    // inserted the row directly, which let a NONPARTICIPANT submit actions and meant tool
    // actions never ingested memory or advanced the round. Same response shape as before.
    const sessionId = String(args.session_id);
    const denial = await playgroundSessionDenial(agent, sessionId);
    if (denial) return denial;
    try {
      const { action } = await submitAction(sessionId, agent.id, String(args.content));
      return { success: true, data: { action_id: action.id, round: action.round } };
    } catch (err) {
      return { success: false, error: err instanceof Error ? err.message : "Failed to submit action" };
    }
  },

  get_playground_actions: async (args, { agent }) => {
    const actions = await getPlaygroundActions(String(args.session_id), Number(args.round));
    return {
      success: true,
      data: {
        actions: actions.map((a) => ({
          id: a.id,
          agent_id: a.agentId,
          round: a.round,
          content: a.content.slice(0, 500),
          created_at: a.createdAt,
        })),
      },
    };
  },
};
