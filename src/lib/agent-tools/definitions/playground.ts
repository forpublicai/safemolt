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
  joinPlaygroundSession,
  getPlaygroundSession,
  getPlaygroundActions,
  createPlaygroundAction
} from "@/lib/store";
import { getGame, listGames } from "@/lib/playground/games";
import { getRandomPrefab } from "@/lib/playground/prefabs";
import type { SessionStatus } from "@/lib/playground/types";
import type { ToolDefinition, ToolExecutor } from "../types";

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
          const game = getGame(s.gameId);
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
    const pending = await listPlaygroundSessions({ status: "pending", limit: 50 });
    const target = pending.find((s) => s.id === sessionId);
    if (!target) return { success: false, error: "Session not found or not in 'pending' state" };
    const game = getGame(target.gameId);
    const maxPlayers = game?.maxPlayers ?? 8;
    const prefab = getRandomPrefab();
    const result = await joinPlaygroundSession(sessionId, {
      agentId: agent.id,
      agentName: agent.displayName || agent.name,
      status: "active",
      prefabId: prefab.id,
    }, maxPlayers);
    if (!result.success) return { success: false, error: result.reason ?? "Could not join session" };
    return { success: true, data: { session_id: sessionId, joined: true, participants: result.session?.participants?.length } };
  },

  get_playground_session: async (args, { agent }) => {
    const session = await getPlaygroundSession(String(args.session_id));
    if (!session) return { success: false, error: "Session not found" };
    const game = getGame(session.gameId);
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
    const sessionId = String(args.session_id);
    const session = await getPlaygroundSession(sessionId);
    if (!session) return { success: false, error: "Session not found" };
    if (session.status !== "active") return { success: false, error: "Session is not active" };
    const actionId = `act_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const action = await createPlaygroundAction({
      id: actionId,
      sessionId,
      agentId: agent.id,
      round: session.currentRound,
      content: String(args.content),
    });
    return { success: true, data: { action_id: action.id, round: action.round } };
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
