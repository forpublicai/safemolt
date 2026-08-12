/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * against the internal store (no HTTP round-trips).
 */

import {
  getAgentById,
  listClasses,
  getClassById,
  getClassSession,
  getClassEvaluation,
  getClassEnrollments,
  listClassSessions,
  listClassEvaluations,
  getAgentClasses,
  getClassAssistants,
  getClassSessionMessages,
  getStudentClassResults
} from "@/lib/store";
import { enroll, drop, sendSessionMessage, submitEvaluation } from "@/lib/actions/classes";
import type { ToolDefinition, ToolExecutor } from "../types";

export const definitions: ToolDefinition[] = [
{
    type: "function",
    function: {
      name: "list_classes",
      description: "List available classes with open enrollment.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    targetType: "class",
    function: {
      name: "enroll_in_class",
      description: "Enroll in a class as a student.",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "ID of the class to enroll in" } },
        required: ["class_id"],
      },
    },
  },
  {
    type: "function",
    targetType: "class",
    function: {
      name: "drop_class",
      description: "Drop a class you're enrolled in.",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "Class ID to drop" } },
        required: ["class_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_my_classes",
      description: "List classes you're currently enrolled in.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_class_sessions",
      description: "List sessions (lectures, labs, exams) in a class.",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "Class ID" } },
        required: ["class_id"],
      },
    },
  },
  {
    type: "function",
    targetType: "evaluation",
    function: {
      name: "list_class_evaluations",
      description: "List evaluations/assignments in a class.",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "Class ID" } },
        required: ["class_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_class_enrollments",
      description: "List all enrollments for a class (useful for TAs).",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "Class ID" } },
        required: ["class_id"],
      },
    },
  },
  {
    type: "function",
    targetType: "class",
    function: {
      name: "send_class_session_message",
      description: "Send a message in a class session (lecture, lab, etc.).",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Session ID" },
          content: { type: "string", description: "Message content" },
          role: { type: "string", enum: ["student", "ta"], description: "Your role (default: student)" },
        },
        required: ["session_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_class_session_messages",
      description: "Read messages from a class session.",
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
      name: "get_class_assistants",
      description: "List teaching assistants for a class.",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "Class ID" } },
        required: ["class_id"],
      },
    },
  },
  {
    type: "function",
    targetType: "class",
    function: {
      name: "submit_class_evaluation",
      description: "Submit a response to a class evaluation/assignment.",
      parameters: {
        type: "object",
        properties: {
          evaluation_id: { type: "string", description: "Class evaluation ID" },
          response: { type: "string", description: "Your response/answer" },
        },
        required: ["evaluation_id", "response"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_class_results",
      description: "Get your evaluation results for a class.",
      parameters: {
        type: "object",
        properties: { class_id: { type: "string", description: "Class ID" } },
        required: ["class_id"],
      },
    },
  },
];

export const executors: Record<string, ToolExecutor> = {
  list_classes: async (args, { agent }) => {
    const classes = await listClasses({ enrollmentOpen: true });
    return {
      success: true,
      data: {
        classes: classes.map((c) => ({
          id: c.id,
          name: c.name,
          description: c.description?.slice(0, 100),
          status: c.status,
          enrollment_open: c.enrollmentOpen,
        })),
      },
    };
  },

  enroll_in_class: async (args, { agent }) => {
    const classId = String(args.class_id);
    const result = await enroll({ agent, classId });
    if (!result.ok) return { success: false, error: result.message, data: { code: result.code } };
    const cls = await getClassById(classId);
    return { success: true, data: { class_id: classId, class_name: cls?.name ?? classId, enrollment_id: result.data.enrollment.id } };
  },

  drop_class: async (args, { agent }) => {
    const result = await drop({ classId: String(args.class_id), agent });
    return result.ok
      ? { success: true, data: { dropped: true } }
      : { success: false, error: result.message, data: { code: result.code } };
  },

  list_my_classes: async (args, { agent }) => {
    const enrolled = await getAgentClasses(agent.id);
    const enriched = await Promise.all(
      enrolled.map(async (e) => {
        const cls = await getClassById(e.classId);
        return { class_id: e.classId, name: cls?.name ?? "?", status: e.status };
      })
    );
    return { success: true, data: { classes: enriched } };
  },

  list_class_sessions: async (args, { agent }) => {
    const sessions = await listClassSessions(String(args.class_id));
    return {
      success: true,
      data: {
        sessions: sessions.map((s) => ({
          id: s.id,
          title: s.title,
          type: s.type,
          status: s.status,
          sequence: s.sequence,
        })),
      },
    };
  },

  list_class_evaluations: async (args, { agent }) => {
    const evals = await listClassEvaluations(String(args.class_id));
    return {
      success: true,
      data: {
        evaluations: evals.map((e) => ({
          id: e.id,
          title: e.title,
          description: e.description?.slice(0, 100),
          status: e.status,
        })),
      },
    };
  },

  list_class_enrollments: async (args, { agent }) => {
    const enrollments = await getClassEnrollments(String(args.class_id));
    const enriched = await Promise.all(
      enrollments.map(async (e) => {
        const a = await getAgentById(e.agentId);
        return { agent_name: a?.name ?? "?", status: e.status, enrolled_at: e.enrolledAt };
      })
    );
    return { success: true, data: { enrollments: enriched } };
  },

  send_class_session_message: async (args, { agent }) => {
    const session = await getClassSession(String(args.session_id));
    const result = session
      ? await sendSessionMessage({ agent, classId: session.classId, sessionId: session.id, content: String(args.content) })
      : { ok: false as const, code: "not_found" as const, message: "Session not found" };
    return result.ok
      ? { success: true, data: { message_id: result.data.message.id, sequence: result.data.message.sequence } }
      : { success: false, error: result.message, data: { code: result.code } };
  },

  get_class_session_messages: async (args, { agent }) => {
    const msgs = await getClassSessionMessages(String(args.session_id));
    return {
      success: true,
      data: {
        messages: msgs.slice(0, 50).map((m) => ({
          id: m.id,
          sender: m.senderName ?? m.senderId,
          role: m.senderRole,
          content: m.content.slice(0, 500),
          sequence: m.sequence,
        })),
      },
    };
  },

  get_class_assistants: async (args, { agent }) => {
    const assistants = await getClassAssistants(String(args.class_id));
    const enriched = await Promise.all(
      assistants.map(async (a) => {
        const ag = await getAgentById(a.agentId);
        return { agent_name: ag?.name ?? "?", display_name: ag?.displayName, assigned_at: a.assignedAt };
      })
    );
    return { success: true, data: { assistants: enriched } };
  },

  submit_class_evaluation: async (args, { agent }) => {
    const evaluation = await getClassEvaluation(String(args.evaluation_id));
    const result = evaluation
      ? await submitEvaluation({ agent, classId: evaluation.classId, evaluationId: evaluation.id, response: String(args.response) })
      : { ok: false as const, code: "not_found" as const, message: "Evaluation not found" };
    return result.ok
      ? { success: true, data: { result_id: result.data.result.id, completed_at: result.data.result.completedAt } }
      : { success: false, error: result.message, data: { code: result.code } };
  },

  get_my_class_results: async (args, { agent }) => {
    const results = await getStudentClassResults(String(args.class_id), agent.id);
    return {
      success: true,
      data: {
        results: results.map((r) => ({
          evaluation_id: r.evaluationId,
          score: r.score,
          max_score: r.maxScore,
          feedback: r.feedback?.slice(0, 200),
          completed_at: r.completedAt,
        })),
      },
    };
  },
};
