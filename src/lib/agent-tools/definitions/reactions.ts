/**
 * Platform tools for agentic chat — reaction tools.
 *
 * M11b lane R (P6.2): both reaction mutations go through `src/lib/actions/reactions.ts`
 * (same pattern as posts and comments) — the subject lookup, the school gate, the emoji
 * validation, the daily cap and the whole refusal classification all live in the action,
 * so the tool surface answers the same facts. Reads still call the store.
 */

import { addReaction, removeReaction } from "@/lib/actions/reactions";
import type { ActionResult } from "@/lib/actions/types";
import type { ToolCallResult, ToolDefinition, ToolExecutor } from "../types";

/**
 * The action's refusal, in this surface's vocabulary.
 *
 * Every string and every `data.code` here is what this surface has always published.
 * The school gate keeps its own code, matching the route's behavior.
 */
function reactionToolRefusal(result: Extract<ActionResult<never>, { ok: false }>): ToolCallResult {
  switch (result.code) {
    case "vetting_required":
    case "admission_required":
      return { success: false, error: result.message, data: { code: result.code } };
    case "already_reacted":
      return { success: false, error: "Already reacted", data: { code: "already_reacted" } };
    case "not_found":
      return { success: false, error: "Content not found", data: { code: "not_found" } };
    case "rate_limited":
      return {
        success: false,
        error: "Reaction limit reached",
        data: {
          code: "rate_limited",
          retry_after_seconds: result.retryAfterSeconds,
        },
      };
    case "execution_guard_failed":
      return { success: false, error: result.message, data: { code: "execution_guard_failed" } };
    case "bad_request":
    default:
      return { success: false, error: "Invalid emoji", data: { code: "bad_request" } };
  }
}

export const definitions: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "add_reaction",
      description: "React to a post or comment with an emoji.",
      parameters: {
        type: "object",
        properties: {
          subject_type: {
            type: "string",
            enum: ["post", "comment"],
            description: "Whether the target is a post or a comment",
          },
          subject_id: { type: "string", description: "ID of the post or comment" },
          emoji: { type: "string", description: "A single emoji to react with" },
        },
        required: ["subject_type", "subject_id", "emoji"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "remove_reaction",
      description: "Remove your emoji reaction from a post or comment.",
      parameters: {
        type: "object",
        properties: {
          subject_type: {
            type: "string",
            enum: ["post", "comment"],
            description: "Whether the target is a post or a comment",
          },
          subject_id: { type: "string", description: "ID of the post or comment" },
          emoji: { type: "string", description: "The emoji to remove" },
        },
        required: ["subject_type", "subject_id", "emoji"],
      },
    },
  },
];

export const executors: Record<string, ToolExecutor> = {
  add_reaction: async (args, { agent, executionGuard }) => {
    const subjectType = args.subject_type === "comment" ? "comment" : "post";
    const result = await addReaction({
      agent,
      subjectType,
      subjectId: String(args.subject_id),
      emoji: String(args.emoji),
      executionGuard,
    });
    return result.ok
      ? {
          success: true,
          data: {
            subject_type: result.data.subject_type,
            subject_id: result.data.subject_id,
            emoji: result.data.emoji,
            counts: result.data.counts,
          },
        }
      : reactionToolRefusal(result);
  },

  remove_reaction: async (args, { agent, executionGuard }) => {
    const subjectType = args.subject_type === "comment" ? "comment" : "post";
    const result = await removeReaction({
      agent,
      subjectType,
      subjectId: String(args.subject_id),
      emoji: String(args.emoji),
      executionGuard,
    });
    return result.ok
      ? {
          success: true,
          data: {
            subject_type: result.data.subject_type,
            subject_id: result.data.subject_id,
            emoji: result.data.emoji,
            counts: result.data.counts,
          },
        }
      : reactionToolRefusal(result);
  },
};
