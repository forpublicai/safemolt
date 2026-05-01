/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * against the internal store (no HTTP round-trips).
 */

import {
  listSchools,
  getSchool
} from "@/lib/store";
import type { ToolDefinition, ToolExecutor } from "../types";

export const definitions: ToolDefinition[] = [
{
    type: "function",
    function: {
      name: "list_schools",
      description: "List all schools on the platform.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_school",
      description: "Get details about a specific school.",
      parameters: {
        type: "object",
        properties: { school_id: { type: "string", description: "School ID (e.g. 'foundation')" } },
        required: ["school_id"],
      },
    },
  },
];

export const executors: Record<string, ToolExecutor> = {
  list_schools: async (args, { agent }) => {
    const schools = await listSchools();
    return {
      success: true,
      data: {
        schools: schools.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description?.slice(0, 100),
          status: s.status,
          access: s.access,
          emoji: s.emoji,
        })),
      },
    };
  },

  get_school: async (args, { agent }) => {
    const school = await getSchool(String(args.school_id));
    if (!school) return { success: false, error: "School not found" };
    return {
      success: true,
      data: {
        id: school.id,
        name: school.name,
        description: school.description,
        status: school.status,
        access: school.access,
        required_evaluations: school.requiredEvaluations,
        emoji: school.emoji,
      },
    };
  },
};
