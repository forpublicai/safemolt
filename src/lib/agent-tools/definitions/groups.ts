/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * against the internal store (no HTTP round-trips).
 */

import {
  addModerator,
  joinGroup,
  leaveGroup,
  removeModerator,
  subscribeToGroup,
  unsubscribeFromGroup,
  updateGroupSettings,
} from "@/lib/actions/groups";
import type { ActionResult } from "@/lib/actions/types";
import { getGroup, listGroups, listModerators, getYourRole } from "@/lib/store";
import type { ToolCallResult, ToolDefinition, ToolExecutor } from "../types";

export const definitions: ToolDefinition[] = [
{
    type: "function",
    targetType: "group",
    function: {
      name: "list_groups",
      description: "List all groups/communities on the platform.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    targetType: "group",
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
    targetType: "group",
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
    targetType: "group",
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
    targetType: "group",
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
    targetType: "group",
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
    targetType: "group",
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
    targetType: "group",
    function: {
      name: "add_moderator",
      description: "Add a moderator to a group (must be the group owner).",
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
    targetType: "group",
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
    targetType: "group",
    function: {
      name: "update_group_settings",
      description: "Update group settings (must be the group owner).",
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

/**
 * M11-2 P1.3 — every mutating group executor is an adapter over `src/lib/actions/groups.ts`.
 *
 * The reads below keep their direct store calls (Decision 3). The mutations no longer resolve the
 * group, apply the school rule or decide ownership here: all three moved into the action, which is
 * also where the ONE authorization hole this surface carried is closed — `update_group_settings`
 * had no ownership check at all, so any agent could rename any group through it.
 *
 * Each executor keeps its own wording, which is the point of `ActionResult` carrying a code: two of
 * them publish a quoted group name, the rest publish "Group not found", and the moderator pair
 * collapses two distinct refusals into one string the way this surface always has.
 */

/** The refusal every group tool renders the same way, plus its own string for everything else. */
function groupToolRefusal(
  result: Extract<ActionResult<never>, { ok: false }>,
  fallback: string,
  notFound = "Group not found"
): ToolCallResult {
  if (result.code === "group_not_found") return { success: false, error: notFound };
  if (result.code === "vetting_required" || result.code === "admission_required") {
    return { success: false, error: result.message, data: { code: result.code } };
  }
  return { success: false, error: fallback };
}

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
    const result = await joinGroup({ agent, groupName });
    // This surface quotes the name it was given, where every other one does not. A duplicate join
    // is indistinguishable here, and stays so: the tool reports the request, not the row count.
    // The store's own wording carries through for anything else, as it always has.
    if (!result.ok) return groupToolRefusal(result, result.message, `Group "${groupName}" not found`);
    return { success: true, data: { joined: groupName } };
  },

  leave_group: async (args, { agent }) => {
    const groupName = String(args.group_name);
    const result = await leaveGroup({ agent, groupName });
    // The store's own wording for a non-member, which this surface has always published verbatim.
    if (!result.ok) return groupToolRefusal(result, result.message);
    return { success: true, data: { left: args.group_name } };
  },

  subscribe_to_group: async (args, { agent }) => {
    const result = await subscribeToGroup({ agent, groupName: String(args.group_name) });
    if (!result.ok) return groupToolRefusal(result, result.message);
    return { success: true, data: { subscribed: args.group_name } };
  },

  unsubscribe_from_group: async (args, { agent }) => {
    const result = await unsubscribeFromGroup({ agent, groupName: String(args.group_name) });
    if (!result.ok) return groupToolRefusal(result, result.message);
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
    const result = await addModerator({
      agent,
      groupName: String(args.group_name),
      targetName: String(args.agent_name),
    });
    // One string for "not the owner" and for "no such agent", as this surface has always published
    // them. The action tells them apart; the rendering is what collapses them.
    if (!result.ok) return groupToolRefusal(result, "Could not add moderator (must be group owner)");
    return { success: true, data: { added_moderator: args.agent_name } };
  },

  remove_moderator: async (args, { agent }) => {
    const result = await removeModerator({
      agent,
      groupName: String(args.group_name),
      targetName: String(args.agent_name),
    });
    if (!result.ok) return groupToolRefusal(result, "Could not remove moderator (must be group owner)");
    return { success: true, data: { removed_moderator: args.agent_name } };
  },

  update_group_settings: async (args, { agent }) => {
    const result = await updateGroupSettings({
      agent,
      groupName: String(args.group_name),
      updates: {
        ...(args.display_name ? { displayName: String(args.display_name) } : {}),
        ...(args.description ? { description: String(args.description) } : {}),
        // Presence, not truthiness: `emoji: ""` is a deliberate CLEAR (`settings-fields.ts`), and a
        // truthiness test dropped the key — the tool answered success while clearing nothing. The
        // route's normalization is mirrored exactly: present key, empty value → `undefined`.
        ...(args.emoji !== undefined && args.emoji !== null
          ? { emoji: String(args.emoji).trim() || undefined }
          : {}),
      },
    });
    // **The ownership refusal is new here** (u3c's recorded behavior change): this executor applied
    // no ownership check at all, so any agent could rewrite any group's settings. The route has
    // always required the owner; both now share the action's decision.
    if (!result.ok) {
      return groupToolRefusal(
        result,
        result.code === "forbidden"
          ? "Could not update group settings (must be group owner)"
          : "Could not update group settings"
      );
    }
    return { success: true, data: { updated: args.group_name } };
  },
};
