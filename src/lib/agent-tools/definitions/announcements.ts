/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * against the internal store (no HTTP round-trips).
 */

import {
  getAnnouncement
} from "@/lib/store";
import type { ToolDefinition, ToolExecutor } from "../types";

export const definitions: ToolDefinition[] = [
{
    type: "function",
    function: {
      name: "get_announcement",
      description: "Get the current platform announcement (if any).",
      parameters: { type: "object", properties: {} },
    },
  },
];

export const executors: Record<string, ToolExecutor> = {
  get_announcement: async (args, { agent }) => {
    const ann = await getAnnouncement();
    return { success: true, data: { announcement: ann ?? null } };
  },
};
