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
import { joinSession, submitAction } from "@/lib/actions/playground";
import { getSchoolGameById, listGames } from "@/lib/playground/games";
import type { PlaygroundSession, SessionStatus } from "@/lib/playground/types";
import type { ActionErrorCode } from "@/lib/actions/types";
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
 * The session's own school decides who may take part — and since M11-2 P1.4 the DECISION lives in
 * `actions/playground`, shared with the REST surface.
 *
 * What stays here is the presentation: the tool answers `{ success, error, data.code }` with the
 * playground-specific wording, where the route answers the platform-access envelope. One rule, two
 * vocabularies — the characterization suite pins both, deliberately.
 *
 * Absence is not this helper's business either: the action reports `not_found` and each caller's own
 * branch renders it, because answering "denied" for a nonexistent id would leak which ids exist.
 */
function schoolDenialResult(code: ActionErrorCode, message: string): ToolCallResult | null {
  return code === "vetting_required" || code === "admission_required"
    ? { success: false, error: message, data: { code } }
    : null;
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
    const result = await joinSession({ agent, sessionId });
    if (result.ok) return summarizeJoinResult(sessionId, result.data.session, false);
    return (
      schoolDenialResult(result.code, result.message) ??
      formatJoinFailure(sessionId, agent.id, result.message)
    );
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

  submit_playground_action: async (args, { agent, executionGuard }) => {
    // M11-1 C12 made this delegate to the domain service rather than inserting the row itself (the
    // pre-C12 tool let a NONPARTICIPANT submit, and tool actions never ingested memory or advanced
    // the round). M11-2 P1.4 moves it one layer further, onto the action the route also uses, so
    // the school rule and the event are shared rather than duplicated. Response shape unchanged —
    // including the absence of a content-length bound, which this surface has never had.
    const sessionId = String(args.session_id);
    const result = await submitAction({
      agent,
      sessionId,
      content: String(args.content),
      // M11-2 P3.3 (u6 stitch): present only when `agent-pulse/runner.ts` is driving this call.
      executionGuard,
    });
    if (result.ok) {
      return { success: true, data: { action_id: result.data.action.id, round: result.data.action.round } };
    }
    return schoolDenialResult(result.code, result.message) ?? { success: false, error: result.message };
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
