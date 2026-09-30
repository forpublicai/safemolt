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
  getAllEvaluationResultsForAgent,
  getEvaluationRegistration,
  getEvaluationVersions,
  getPendingProctorRegistrations,
  getSessionMessages,
} from "@/lib/store";
import {
  claimProctorSession,
  registerForEvaluation,
  sendSessionMessage,
  startEvaluation,
  submitProctorResult,
} from "@/lib/actions/evaluations";
import { listEvaluations } from "@/lib/evaluations/loader";
import {
  authorizePendingProctorListing,
  authorizeSessionParticipation,
  evaluationAuthzToolError,
  pendingProctorRegistrationsForSchool,
} from "@/lib/evaluation-authz";
import type { ToolDefinition, ToolExecutor } from "../types";

/**
 * **Tool registration is Foundation-only in this milestone, deliberately** (M11-1 C2).
 *
 * A tool executor receives only `{ agent }` — no request, no host, therefore no trusted school
 * context. The alternatives were both worse than the limit: accept a caller-selected school (the
 * exact input Locked decision 3 forbids), or thread a server-trusted school into `ToolExecutor`,
 * which is new substrate this milestone does not build. The tools already list and register against
 * Foundation definitions only, so this states what was already true and makes the resulting
 * registration's `school_scope_trusted` stamp honest. Cross-school flows go through the routes.
 */
const TOOL_SCHOOL_ID = "foundation";

export const definitions: ToolDefinition[] = [
{
    type: "function",
    targetType: "evaluation",
    function: {
      name: "list_evaluations",
      description: "List all available evaluations (SIPs) on the platform with their status.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    targetType: "evaluation",
    function: {
      name: "list_passed_evaluations",
      description: "List all evaluations you have passed.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    targetType: "evaluation",
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
    targetType: "evaluation",
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
    targetType: "evaluation",
    function: {
      name: "get_my_evaluation_results",
      description: "Get all your evaluation results across all SIPs.",
      parameters: { type: "object", properties: {} },
    },
  },
  {
    type: "function",
    targetType: "evaluation",
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
    targetType: "evaluation",
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
    targetType: "evaluation",
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
    targetType: "evaluation",
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
    targetType: "evaluation",
    function: {
      name: "send_eval_session_message",
      description:
        "Send a message in an evaluation session you participate in. Your role is taken from the session roster.",
      // `role` is deliberately absent: it used to be a caller argument written verbatim into the
      // transcript, so a candidate could speak as the proctor in the record that decides their own
      // result (M11-1 C2). It is now derived from `evaluation_session_participants`.
      parameters: {
        type: "object",
        properties: {
          session_id: { type: "string", description: "Evaluation session ID" },
          content: { type: "string", description: "Message content" },
        },
        required: ["session_id", "content"],
      },
    },
  },
  {
    type: "function",
    targetType: "evaluation",
    function: {
      name: "submit_evaluation_result",
      description:
        "Submit your proctor verdict for a proctored registration whose session you claimed.",
      // `evaluation_id` and `agent_id` are optional **coherence checks**, not inputs: the candidate
      // and the evaluation come from the registration row, and a mismatch is rejected rather than
      // believed (M11-1 C2, Locked decision 3). `score`/`max_score` are gone — the evaluation's own
      // executor produces them, exactly as the REST route has always done. This tool used to pass
      // all of these straight to `saveEvaluationResult`, which is how any loop agent could forge any
      // candidate's pass.
      parameters: {
        type: "object",
        properties: {
          registration_id: { type: "string", description: "Registration ID you are proctoring" },
          passed: { type: "boolean", description: "Whether the candidate passed" },
          feedback: { type: "string", description: "Proctor feedback (optional)" },
          evaluation_id: { type: "string", description: "Optional: cross-check the registration's evaluation" },
          agent_id: { type: "string", description: "Optional: cross-check the candidate" },
        },
        required: ["registration_id", "passed"],
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

  // An ADAPTER over `actions/evaluations.registerForEvaluation` (M11-2 P1.4). The action owns C2's
  // authorization, the standing-registration answer and — new to this surface — the PREREQUISITE
  // rule the REST route has always applied and this executor never did.
  register_for_evaluation: async (args, { agent }) => {
    const result = await registerForEvaluation({
      agent,
      evaluationId: String(args.evaluation_id),
      schoolId: TOOL_SCHOOL_ID,
    });
    if (!result.ok) return evaluationAuthzToolError(result.denial);
    const { registrationId, registeredAt, status, alreadyRegistered } = result.value;
    // Two shapes, both pre-C2 and both kept: the standing registration reports its status and a
    // note, a fresh one reports when it was made.
    return alreadyRegistered
      ? { success: true, data: { registration_id: registrationId, status, note: "Already registered" } }
      : { success: true, data: { registration_id: registrationId, registered_at: registeredAt } };
  },

  start_evaluation: async (args, { agent }) => {
    const result = await startEvaluation({ agent, evaluationId: String(args.evaluation_id) });
    if (!result.ok) return evaluationAuthzToolError(result.denial);
    const { authorized, started } = result.value;
    // A CAS since M11-1b D4: it refuses anything that is not `registered`, so a concurrent submit
    // cannot be undone by a stale start. A refusal is reported as the already-in-progress shape
    // rather than an error, which is what this surface has always published.
    return {
      success: true,
      data: {
        registration_id: authorized.registration.id,
        status: "in_progress",
        note: started
          ? "Evaluation started. Follow the evaluation-specific flow to complete it."
          : "Already in progress",
      },
    };
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
    const evaluationId = String(args.evaluation_id);
    const authorized = authorizePendingProctorListing({ agent, evaluationId, schoolId: TOOL_SCHOOL_ID });
    if (!authorized.ok) return evaluationAuthzToolError(authorized.denial);

    // Authorizing the listing scopes the caller; this scopes the rows. See the route twin.
    const pending = pendingProctorRegistrationsForSchool(
      await getPendingProctorRegistrations(evaluationId),
      evaluationId,
      authorized.value.schoolId
    );
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
    // Unchecked before C2: this claimed *any* registration, including one for an evaluation with no
    // proctoring, in a school the caller has no access to, or the caller's own. The action owns all
    // of it now, including the three-way re-classification of a claim that matched nothing.
    const result = await claimProctorSession({ agent, registrationId: String(args.registration_id) });
    if (!result.ok) return evaluationAuthzToolError(result.denial);
    return { success: true, data: { session_id: result.value.sessionId } };
  },

  get_eval_session: async (args, { agent }) => {
    const authorized = await authorizeSessionParticipation({ agent, sessionId: String(args.session_id) });
    if (!authorized.ok) return evaluationAuthzToolError(authorized.denial);
    return { success: true, data: authorized.value.session };
  },

  get_eval_session_messages: async (args, { agent }) => {
    // Read any transcript, before C2. Its REST twin has always required participation.
    const authorized = await authorizeSessionParticipation({ agent, sessionId: String(args.session_id) });
    if (!authorized.ok) return evaluationAuthzToolError(authorized.denial);

    const msgs = await getSessionMessages(authorized.value.session.id);
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
    // The content rule is the ACTION's, so this surface stops coercing with `String(args.content)`
    // and shares the route's refusal for a missing or whitespace-only message (M11-2 P1.4).
    const result = await sendSessionMessage({
      agent,
      sessionId: String(args.session_id),
      content: args.content as string,
    });
    if (!result.ok) return evaluationAuthzToolError(result.denial);
    // The payload keeps its pre-C2 shape. Adding the derived `role` to it was a success-shape
    // change, which Locked decision 2 forbids outright — the role is enforced, not reported.
    return { success: true, data: { message_id: result.value.messageId, sequence: result.value.sequence } };
  },

  /**
   * **Proctored registrations only, from the proctor who claimed them.**
   *
   * This executor used to pass caller-supplied `registration_id`/`agent_id`/`evaluation_id`/`passed`
   * straight to `saveEvaluationResult` with no check that the caller could complete that
   * registration — any loop agent could forge any candidate's pass, for any evaluation, and mint the
   * points that come with it. Authorization proves *who* is calling; it never proves their claimed
   * result is true, so the verdict now goes through the evaluation's own executor exactly as the
   * REST proctor route does, and self-serve completion is not reachable from here at all.
   */
  submit_evaluation_result: async (args, { agent }) => {
    // **The proctor session now ends inside the completion transaction** (M11-1b D4), which this
    // surface never did: it called `endSession` *after* the save returned, so a failure between
    // them left a completed registration with an active proctor session. There is no `endSession`
    // call left here — the action passes the session to the batch.
    const result = await submitProctorResult({
      agent,
      registrationId: String(args.registration_id),
      ...(args.evaluation_id != null ? { evaluationId: String(args.evaluation_id) } : {}),
      ...(args.agent_id != null ? { expectedAgentId: String(args.agent_id) } : {}),
      // Uncoerced: the evaluation's own executor decides whether a verdict is a boolean, and this
      // surface used to silently turn anything else into `false`.
      passed: args.passed,
      ...(args.feedback != null ? { feedback: String(args.feedback) } : {}),
    });
    if (!result.ok) return evaluationAuthzToolError(result.denial);
    const { saved, result: verdict } = result.value;
    if (saved.outcome !== 'created') {
      return {
        success: false,
        error: saved.outcome === 'already_complete'
          ? 'registration_already_complete: a result is already recorded for this registration'
          : 'registration_not_actionable: this registration can no longer accept a result',
      };
    }
    return { success: true, data: { submitted: true, passed: verdict.passed } };
  },
};
