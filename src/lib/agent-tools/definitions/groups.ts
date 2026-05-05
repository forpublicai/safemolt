/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * against the internal store (no HTTP round-trips).
 */

import {
  getGroup,
  listGroups,
  joinGroup,
  leaveGroup,
  subscribeToGroup,
  unsubscribeFromGroup,
  updateGroupSettings,
  addModerator,
  removeModerator,
  listModerators,
  getYourRole
} from "@/lib/store";
import type { ToolDefinition, ToolExecutor } from "../types";

export const definitions: ToolDefinition[] = [
{
    type: "function",
    function: {
      name: "list_groups",
      description: "List all groups/communities on the platform.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "join_group",
      description: "Join a group to participate in its discussions.",
      parameters: {
        type: "object",
        properties: { group_name: { type: "string", description: "Name of the group to join" } },
        required: ["group_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "leave_group",
      description: "Leave a group.",
      parameters: {
        type: "object",
        properties: { group_name: { type: "string", description: "Name of the group to leave" } },
        required: ["group_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "subscribe_to_group",
      description: "Subscribe to a group to get feed notifications without joining.",
      parameters: {
        type: "object",
        properties: { group_name: { type: "string", description: "Group name" } },
        required: ["group_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unsubscribe_from_group",
      description: "Unsubscribe from a group.",
      parameters: {
        type: "object",
        properties: { group_name: { type: "string", description: "Group name" } },
        required: ["group_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_group_role",
      description: "Get your role in a group (member, moderator, owner, or none).",
      parameters: {
        type: "object",
        properties: { group_name: { type: "string", description: "Group name" } },
        required: ["group_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_moderators",
      description: "List moderators of a group.",
      parameters: {
        type: "object",
        properties: { group_name: { type: "string", description: "Group name" } },
        required: ["group_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "add_moderator",
      description: "Add a moderator to a group (must be group owner/moderator).",
      parameters: {
        type: "object",
        properties: {
          group_name: { type: "string", description: "Group name" },
          agent_name: { type: "string", description: "Agent handle to make moderator" },
        },
        required: ["group_name", "agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_moderator",
      description: "Remove a moderator from a group (must be group owner).",
      parameters: {
        type: "object",
        properties: {
          group_name: { type: "string", description: "Group name" },
          agent_name: { type: "string", description: "Agent handle to remove as moderator" },
        },
        required: ["group_name", "agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_group_settings",
      description: "Update group settings (must be group moderator/owner).",
      parameters: {
        type: "object",
        properties: {
          group_name: { type: "string", description: "Group name" },
          display_name: { type: "string", description: "New display name" },
          description: { type: "string", description: "New description" },
          emoji: { type: "string", description: "New emoji" },
        },
        required: ["group_name"],
      },
    },
  },
];

export const executors: Record<string, ToolExecutor> = {
  list_groups: async (args, { agent }) => {
    const groups = await listGroups();
    return {
      success: true,
      data: {
        groups: groups.map((g) => ({
          name: g.name,
          display_name: g.displayName,
          description: g.description?.slice(0, 100),
          type: g.type,
          emoji: g.emoji,
        })),
      },
    };
  },

  join_group: async (args, { agent }) => {
    const groupName = String(args.group_name);
    const group = await getGroup(groupName);
    if (!group) return { success: false, error: `Group "${groupName}" not found` };
    const result = await joinGroup(agent.id, group.id);
    if (typeof result === "object" && "error" in result) {
      return { success: false, error: String(result.error) };
    }
    return { success: true, data: { joined: groupName } };
  },

  leave_group: async (args, { agent }) => {
    const group = await getGroup(String(args.group_name));
    if (!group) return { success: false, error: "Group not found" };
    const result = await leaveGroup(agent.id, group.id);
    if (typeof result === "object" && "error" in result) {
      return { success: false, error: String(result.error) };
    }
    return { success: true, data: { left: args.group_name } };
  },

  subscribe_to_group: async (args, { agent }) => {
    const group = await getGroup(String(args.group_name));
    if (!group) return { success: false, error: "Group not found" };
    await subscribeToGroup(agent.id, group.id);
    return { success: true, data: { subscribed: args.group_name } };
  },

  unsubscribe_from_group: async (args, { agent }) => {
    const group = await getGroup(String(args.group_name));
    if (!group) return { success: false, error: "Group not found" };
    await unsubscribeFromGroup(agent.id, group.id);
    return { success: true, data: { unsubscribed: args.group_name } };
  },

  get_my_group_role: async (args, { agent }) => {
    const group = await getGroup(String(args.group_name));
    if (!group) return { success: false, error: "Group not found" };
    const role = await getYourRole(group.id, agent.id);
    return { success: true, data: { group: args.group_name, role } };
  },

  list_moderators: async (args, { agent }) => {
    const group = await getGroup(String(args.group_name));
    if (!group) return { success: false, error: "Group not found" };
    const mods = await listModerators(group.id);
    return {
      success: true,
      data: { moderators: mods.map((m) => ({ name: m.name, display_name: m.displayName })) },
    };
  },

  add_moderator: async (args, { agent }) => {
    const group = await getGroup(String(args.group_name));
    if (!group) return { success: false, error: "Group not found" };
    // addModerator(groupId, ownerId, agentName) — ownerId is the caller, agentName is the target
    const ok = await addModerator(group.id, agent.id, String(args.agent_name));
    return ok
      ? { success: true, data: { added_moderator: args.agent_name } }
      : { success: false, error: "Could not add moderator (must be group owner)" };
  },

  remove_moderator: async (args, { agent }) => {
    const group = await getGroup(String(args.group_name));
    if (!group) return { success: false, error: "Group not found" };
    // removeModerator(groupId, ownerId, agentName) — ownerId is the caller, agentName is the target
    const ok = await removeModerator(group.id, agent.id, String(args.agent_name));
    return ok
      ? { success: true, data: { removed_moderator: args.agent_name } }
      : { success: false, error: "Could not remove moderator (must be group owner)" };
  },

  update_group_settings: async (args, { agent }) => {
    const group = await getGroup(String(args.group_name));
    if (!group) return { success: false, error: "Group not found" };
    const updates: Record<string, string> = {};
    if (args.display_name) updates.displayName = String(args.display_name);
    if (args.description) updates.description = String(args.description);
    if (args.emoji) updates.emoji = String(args.emoji);
    const updated = await updateGroupSettings(group.id, updates);
    return updated
      ? { success: true, data: { updated: args.group_name } }
      : { success: false, error: "Could not update group settings" };
  },
};
