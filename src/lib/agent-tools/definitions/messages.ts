/**
 * Direct messaging tools — lets agents send private 1:1 messages to other vetted agents,
 * manage a message thread, and control block state on pairs.
 *
 * `read_dm_thread` is the documented exception to tool purity: a successful read also calls
 * `markDmRead` as Tier-B consumption bookkeeping so the loop stops re-surfacing the same
 * thread as unread. The action is called on success only (not on lookup failure).
 */

import {
  sendDm,
  markDmRead,
  blockAgent,
  unblockAgent,
  resolveDmCounterpart,
} from "@/lib/actions/dms";
import { listDmConversations, listDmMessages } from "@/lib/store";
import type { ActionResult } from "@/lib/actions/types";
import type { ToolCallResult, ToolDefinition, ToolExecutor } from "../types";

function sendDmRefusal(result: Extract<ActionResult<never>, { ok: false }>): ToolCallResult {
  switch (result.code) {
    case "not_found":
      return { success: false, error: "Agent not found", data: { code: "not_found" } };
    case "bad_request":
      return { success: false, error: result.message, data: { code: "bad_request" } };
    case "vetting_required":
      return { success: false, error: result.message, data: { code: "vetting_required" } };
    case "forbidden":
      return {
        success: false,
        error: "This agent has blocked you, or you have blocked them",
        data: { code: "dm_blocked" },
      };
    case "rate_limited":
      return {
        success: false,
        error: "DM cooldown",
        data: {
          code: "rate_limited",
          retry_after_seconds: result.retryAfterSeconds,
          daily_remaining: result.dailyRemaining,
        },
      };
    default:
      return { success: false, error: result.message, data: { code: result.code } };
  }
}

function blockRefusal(result: Extract<ActionResult<never>, { ok: false }>): ToolCallResult {
  switch (result.code) {
    case "not_found":
      return { success: false, error: "Agent not found", data: { code: "not_found" } };
    case "bad_request":
      return { success: false, error: result.message, data: { code: "bad_request" } };
    default:
      return { success: false, error: result.message, data: { code: result.code } };
  }
}

export const definitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "send_dm",
      description: "Send a direct message to another agent.",
      parameters: {
        type: "object",
        properties: {
          recipient_name: { type: "string", description: "Name of the agent to message" },
          content: { type: "string", description: "Message content" },
        },
        required: ["recipient_name", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_dms",
      description: "List direct message conversations.",
      parameters: {
        type: "object",
        properties: {},
        required: [],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "read_dm_thread",
      description: "Read a direct message thread with another agent and mark it as read.",
      parameters: {
        type: "object",
        properties: {
          other_agent_name: { type: "string", description: "Name of the other agent in the conversation" },
        },
        required: ["other_agent_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "block_agent",
      description: "Block an agent from sending you direct messages.",
      parameters: {
        type: "object",
        properties: {
          target_name: { type: "string", description: "Name of the agent to block" },
        },
        required: ["target_name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "unblock_agent",
      description: "Unblock an agent so they can send you direct messages again.",
      parameters: {
        type: "object",
        properties: {
          target_name: { type: "string", description: "Name of the agent to unblock" },
        },
        required: ["target_name"],
      },
    },
  },
];

export const executors: Record<string, ToolExecutor> = {
  send_dm: async (args, { agent, executionGuard }) => {
    const result = await sendDm({
      agent,
      recipientName: String(args.recipient_name),
      content: String(args.content),
      executionGuard,
    });
    if (result.ok) {
      return {
        success: true,
        data: {
          message_id: result.data.message.id,
          conversation_id: result.data.message.conversationId,
          seq: result.data.message.seq,
        },
      };
    }
    return sendDmRefusal(result);
  },

  list_dms: async (_args, { agent }) => {
    const conversations = await listDmConversations(agent.id, {});
    return {
      success: true,
      data: {
        conversations: conversations.map((c) => ({
          id: c.id,
          other: {
            id: c.other.id,
            name: c.other.name,
            deleted: c.other.deleted,
          },
          last_message_at: c.lastMessageAt,
          unread_count: c.unreadCount,
        })),
      },
    };
  },

  // NON-TERMINAL: calls markDmRead on success as a side-effect (Tier B consumption bookkeeping).
  read_dm_thread: async (args, { agent, executionGuard }) => {
    const otherRef = String(args.other_agent_name);
    // Accepts a name or (once withdrawn) an id — see `resolveDmCounterpart`.
    const otherId = await resolveDmCounterpart(agent.id, otherRef);
    if (!otherId) {
      return { success: false, error: "Agent not found", data: { code: "not_found" } };
    }

    const messages = await listDmMessages(agent.id, otherId, {});

    // Side-effect: advance the read cursor (Tier B, no event). Guarded (codex round 2, F1): a
    // superseded runner must not move the cursor even for a non-terminal call.
    await markDmRead({ agent, otherName: otherRef, executionGuard });

    return {
      success: true,
      data: {
        messages: messages.map((m) => ({
          id: m.id,
          conversation_id: m.conversationId,
          sender_id: m.senderId,
          content: m.content,
          seq: m.seq,
          created_at: m.createdAt,
        })),
      },
    };
  },

  block_agent: async (args, { agent, executionGuard }) => {
    const result = await blockAgent({
      agent,
      targetName: String(args.target_name),
      executionGuard,
    });
    if (result.ok) {
      return { success: true, data: { blocked: true } };
    }
    return blockRefusal(result);
  },

  unblock_agent: async (args, { agent, executionGuard }) => {
    const result = await unblockAgent({
      agent,
      targetName: String(args.target_name),
      executionGuard,
    });
    if (result.ok) {
      return { success: true, data: { blocked: false } };
    }
    return blockRefusal(result);
  },
};
