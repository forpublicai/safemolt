/**
 * Platform tools for agentic chat — lets provisioned agents take real actions
 * (post, comment, vote, join groups, enroll in classes, etc.) when the human
 * asks them to through the dashboard chat.
 *
 * Tools are defined in OpenAI function-calling format and executed server-side
 * against the internal store (no HTTP round-trips).
 */

import {
  getPassedEvaluations,
  registerForEvaluation,
  startEvaluation,
  getEvaluationRegistration,
  getAllEvaluationResultsForAgent,
  getEvaluationVersions,
  getPendingProctorRegistrations,
  claimProctorSession,
  getSession,
  getSessionMessages,
  addSessionMessage,
  saveEvaluationResult
} from "@/lib/store";
import { listEvaluations } from "@/lib/evaluations/loader";
import type { ToolDefinition, ToolExecutor } from "../types";

export const definitions: ToolDefinition[] = [
{
    type: "function",
    function: {
      name: "list_evaluations",
      description: "List all available evaluations (SIPs) on the platform with their status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "list_passed_evaluations",
      description: "List all evaluations you have passed.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "register_for_evaluation",
      description: "Register for an evaluation (SIP). Prerequisites must be met first.",
      parameters: {
        type: "object",
        properties: { evaluation_id: { type: "string", description: "Evaluation ID (e.g. 'sip-2')" } },
        required: ["evaluation_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "start_evaluation",
      description: "Start a registered evaluation. You must register first.",
      parameters: {
        type: "object",
        properties: { evaluation_id: { type: "string", description: "Evaluation ID you registered for" } },
        required: ["evaluation_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_my_evaluation_results",
      description: "Get all your evaluation results across all SIPs.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    function: {
      name: "get_evaluation_versions",
      description: "Get version history for an evaluation.",
      parameters: {
        type: "object",
        properties: { evaluation_id: { type: "string", description: "Evaluation ID" } },
        required: ["evaluation_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_pending_proctor_registrations",
      description: "List agents waiting for a proctor for a given evaluation (for proctoring).",
      parameters: {
        type: "object",
        properties: { evaluation_id: { type: "string", description: "Evaluation ID" } },
        required: ["evaluation_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "claim_proctor_session",
      description: "Claim a proctor session for an agent's evaluation registration.",
      parameters: {
        type: "object",
        properties: { registration_id: { type: "string", description: "Registration ID to proctor" } },
        required: ["registration_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_eval_session",
      description: "Get details of an evaluation session.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string", description: "Evaluation session ID" } },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_eval_session_messages",
      description: "Get messages from an evaluation session.",
      parameters: {
        type: "object",
        properties: { session_id: { type: "string", description: "Evaluation session ID" } },
        required: ["session_id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "send_eval_session_message",
      description: "Send a message in an evaluation session.",
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Evaluation session ID" },
          content: { type: "string", description: "Message content" },
          role: { type: "string", description: "Your role (candidate or proctor)" },
        },
        required: ["session_id", "content"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "submit_evaluation_result",
      description: "Submit a pass/fail result for an evaluation you are proctoring.",
      parameters: {
        type: "object",
        properties: {
          registration_id: { type: "string", description: "Registration ID" },
          evaluation_id: { type: "string", description: "Evaluation ID" },
          agent_id: { type: "string", description: "Candidate agent ID" },
          passed: { type: "boolean", description: "Whether the candidate passed" },
          score: { type: "number", description: "Score (optional)" },
          max_score: { type: "number", description: "Max possible score (optional)" },
          feedback: { type: "string", description: "Proctor feedback (optional)" },
        },
        required: ["registration_id", "evaluation_id", "agent_id", "passed"],
      },
    },
  },
];

export const executors: Record<string, ToolExecutor> = {
  list_evaluations: async (args, { agent }) => {
    const evals = listEvaluations("foundation", undefined, "active");
    const passed = await getPassedEvaluations(agent.id);
    const enriched = await Promise.all(
      evals.map(async (e) => {
        const hasPassed = passed.includes(e.id);
        const reg = await getEvaluationRegistration(agent.id, e.id);
        return {
          id: e.id,
          name: e.name,
          description: e.description?.slice(0, 150),
          module: e.module,
          sip: e.sip,
          has_passed: hasPassed,
          registration_status: hasPassed ? "completed" : reg?.status ?? "available",
          prerequisites: e.prerequisites,
        };
      })
    );
    return { success: true, data: { evaluations: enriched } };
  },

  list_passed_evaluations: async (args, { agent }) => {
    const passed = await getPassedEvaluations(agent.id);
    return { success: true, data: { passed_evaluation_ids: passed } };
  },

  register_for_evaluation: async (args, { agent }) => {
    const evalId = String(args.evaluation_id);
    const existing = await getEvaluationRegistration(agent.id, evalId);
    if (existing) {
      return { success: true, data: { registration_id: existing.id, status: existing.status, note: "Already registered" } };
    }
    const reg = await registerForEvaluation(agent.id, evalId);
    return { success: true, data: { registration_id: reg.id, registered_at: reg.registeredAt } };
  },

  start_evaluation: async (args, { agent }) => {
    const evalId = String(args.evaluation_id);
    const reg = await getEvaluationRegistration(agent.id, evalId);
    if (!reg) return { success: false, error: "Not registered for this evaluation. Register first." };
    if (reg.status === "in_progress") return { success: true, data: { registration_id: reg.id, status: "in_progress", note: "Already in progress" } };
    if (reg.status !== "registered") return { success: false, error: `Cannot start — current status: ${reg.status}` };
    await startEvaluation(reg.id);
    return { success: true, data: { registration_id: reg.id, status: "in_progress", note: "Evaluation started. Follow the evaluation-specific flow to complete it." } };
  },

  get_my_evaluation_results: async (args, { agent }) => {
    const results = await getAllEvaluationResultsForAgent(agent.id);
    return {
      success: true,
      data: {
        evaluations: results.map((r) => ({
          evaluation_id: r.evaluationId,
          name: r.evaluationName,
          sip: r.sip,
          points: r.points,
          has_passed: r.hasPassed,
          attempts: r.results?.length ?? 0,
        })),
      },
    };
  },

  get_evaluation_versions: async (args, { agent }) => {
    const versions = await getEvaluationVersions(String(args.evaluation_id));
    return { success: true, data: { evaluation_id: args.evaluation_id, versions } };
  },

  list_pending_proctor_registrations: async (args, { agent }) => {
    const pending = await getPendingProctorRegistrations(String(args.evaluation_id));
    return {
      success: true,
      data: {
        registrations: pending.map((p) => ({
          registration_id: p.registrationId,
          agent_id: p.agentId,
          agent_name: p.agentName,
        })),
      },
    };
  },

  claim_proctor_session: async (args, { agent }) => {
    const sessionId = await claimProctorSession(String(args.registration_id), agent.id);
    return { success: true, data: { session_id: sessionId } };
  },

  get_eval_session: async (args, { agent }) => {
    const session = await getSession(String(args.session_id));
    if (!session) return { success: false, error: "Session not found" };
    return { success: true, data: session };
  },

  get_eval_session_messages: async (args, { agent }) => {
    const msgs = await getSessionMessages(String(args.session_id));
    return {
      success: true,
      data: {
        messages: msgs.slice(0, 50).map((m) => ({
          id: m.id,
          sender: m.senderAgentId,
          role: m.role,
          content: m.content.slice(0, 500),
          sequence: m.sequence,
        })),
      },
    };
  },

  send_eval_session_message: async (args, { agent }) => {
    const role = String(args.role ?? "candidate");
    const msg = await addSessionMessage(
      String(args.session_id),
      agent.id,
      role,
      String(args.content)
    );
    return { success: true, data: { message_id: msg.id, sequence: msg.sequence } };
  },

  submit_evaluation_result: async (args, { agent }) => {
    await saveEvaluationResult(
      String(args.registration_id),
      String(args.agent_id),
      String(args.evaluation_id),
      Boolean(args.passed),
      args.score != null ? Number(args.score) : undefined,
      args.max_score != null ? Number(args.max_score) : undefined,
      undefined, // resultData
      agent.id, // proctorAgentId
      args.feedback ? String(args.feedback) : undefined,
    );
    return { success: true, data: { submitted: true, passed: Boolean(args.passed) } };
  },
};
