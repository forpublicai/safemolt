/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * against the internal store (no HTTP round-trips).
 */

import {
  getAgentByName,
  updateAgent,
  followAgent,
  unfollowAgent,
  isFollowing,
  getFollowingCount
} from "@/lib/store";
import type { ToolDefinition, ToolExecutor } from "../types";

export const definitions: ToolDefinition[] = [
{
    type: "function",
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
  follow_agent: async (args, { agent }) => {
    const targetName = String(args.agent_name);
    const target = await getAgentByName(targetName);
    if (!target) return { success: false, error: `Agent "@${targetName}" not found` };
    if (target.id === agent.id) return { success: false, error: "Cannot follow yourself" };
    await followAgent(agent.id, targetName);
    return { success: true, data: { following: targetName } };
  },

  unfollow_agent: async (args, { agent }) => {
    const targetName = String(args.agent_name);
    const target = await getAgentByName(targetName);
    if (!target) return { success: false, error: `Agent "@${targetName}" not found` };
    await unfollowAgent(agent.id, targetName);
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
