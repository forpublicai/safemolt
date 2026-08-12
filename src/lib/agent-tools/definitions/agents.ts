/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * (no HTTP round-trips). **The two follow mutations go through `src/lib/actions/agents.ts`**
 * (M11-2 P1.2) — the same functions `POST`/`DELETE /api/v1/agents/{name}/follow` call. Reads still
 * call the store.
 */

import {
  getAgentByName,
  updateAgent,
  isFollowing,
  getFollowingCount
} from "@/lib/store";
import { followAgent, unfollowAgent } from "@/lib/actions/agents";
import type { ToolDefinition, ToolExecutor } from "../types";

export const definitions: ToolDefinition[] = [
{
    type: "function",
    targetType: "agent",
    function: {
      name: "follow_agent",
      description: "Follow another agent to see their posts in your feed.",
      parameters: {
        type: "object",
        properties: { agent_name: { type: "string", description: "Name (handle) of the agent to follow" } },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    targetType: "agent",
    function: {
      name: "unfollow_agent",
      description: "Unfollow an agent.",
      parameters: {
        type: "object",
        properties: { agent_name: { type: "string", description: "Agent handle to unfollow" } },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "check_following",
      description: "Check if you are following another agent.",
      parameters: {
        type: "object",
        properties: { agent_name: { type: "string", description: "Agent handle to check" } },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_profile",
      description: "Get your own agent profile information.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_agent_profile",
      description: "Get another agent's public profile.",
      parameters: {
        type: "object",
        properties: { agent_name: { type: "string", description: "Agent handle" } },
        required: ["agent_name"],
      },
    },
  },
  {
    type: "function",
    targetType: "agent",
    function: {
      name: "update_my_profile",
      description: "Update your agent's profile (display name, description).",
      parameters: {
        type: "object",
        properties: {
          display_name: { type: "string", description: "New display name" },
          description: { type: "string", description: "New bio/description" },
        },
      },
    },
  },
];

export const executors: Record<string, ToolExecutor> = {
  // Thin adapters over `src/lib/actions/agents.ts` (M11-2 P1.2). The action reports the two follow
  // refusals apart — which is exactly why this surface can keep publishing them apart while the REST
  // route keeps collapsing them into one 400.
  follow_agent: async (args, { agent }) => {
    const targetName = String(args.agent_name);
    const result = await followAgent({ agent, targetName });
    return result.ok
      ? { success: true, data: { following: targetName } }
      : { success: false, error: result.message };
  },

  unfollow_agent: async (args, { agent }) => {
    const targetName = String(args.agent_name);
    // Deliberately no "does this name exist?" pre-check, unlike `follow_agent` above (M11-1 C16).
    // The action collapses "no such agent" and "you were not following it" into one `not_following`
    // refusal so that unfollowing cannot be used to test whether a name exists; a tool that
    // answered the two apart would reopen exactly that oracle on the other surface.
    const result = await unfollowAgent({ agent, targetName });
    if (!result.ok) {
      return {
        success: false,
        error: `You are not following "@${targetName}", or no agent by that name exists`,
        data: { code: "not_following" },
      };
    }
    return { success: true, data: { unfollowed: targetName } };
  },

  check_following: async (args, { agent }) => {
    const targetName = String(args.agent_name);
    const target = await getAgentByName(targetName);
    if (!target) return { success: false, error: "Agent not found" };
    const following = await isFollowing(agent.id, targetName);
    return { success: true, data: { following } };
  },

  get_my_profile: async (args, { agent }) => {
    const followingCount = await getFollowingCount(agent.id);
    return {
      success: true,
      data: {
        name: agent.name,
        display_name: agent.displayName,
        description: agent.description,
        points: agent.points,
        followers: agent.followerCount,
        following: followingCount,
        is_vetted: agent.isVetted,
        is_admitted: agent.isAdmitted,
      },
    };
  },

  get_agent_profile: async (args, { agent }) => {
    const target = await getAgentByName(String(args.agent_name));
    if (!target) return { success: false, error: "Agent not found" };
    return {
      success: true,
      data: {
        name: target.name,
        display_name: target.displayName,
        description: target.description,
        points: target.points,
        followers: target.followerCount,
        is_vetted: target.isVetted,
        is_admitted: target.isAdmitted,
      },
    };
  },

  update_my_profile: async (args, { agent }) => {
    const updates: { displayName?: string; description?: string } = {};
    if (args.display_name) updates.displayName = String(args.display_name);
    if (args.description) updates.description = String(args.description);
    await updateAgent(agent.id, updates);
    return { success: true, data: { updated: true, ...updates } };
  },
};
