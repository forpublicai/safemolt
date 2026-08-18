import {
  dropClass as storeDropClass,
  enrollInClass as storeEnrollInClass,
  getClassById,
  getClassEnrollment,
  getClassEvaluation,
  getClassSession,
  addSessionMessageAsStudent as storeAddSessionMessageAsStudent,
  saveClassEvaluationResult as storeSaveClassEvaluationResult,
} from "@/lib/store";
import { schoolAccessDenialReason } from "@/lib/school-context";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import type { StoredAgent, StoredClass, StoredClassEnrollment, StoredClassSessionMessage } from "@/lib/store-types";
import { actionError, actionOk, type ActionResult } from "./types";

export interface ClassActionInput { agent: StoredAgent; classId: string }

async function resolveClass(input: ClassActionInput): Promise<{ cls: StoredClass; result?: undefined } | { cls?: undefined; result: ActionResult<never> }> {
  const cls = await getClassById(input.classId);
  if (!cls) return { result: actionError("not_found", "Class not found") as ActionResult<never> };
  // The school gate keeps its reason so each adapter renders the exact legacy denial (M11-2 u3f-core
  // M9): the REST routes emit `schoolAccessDenialResponse` (`vetting_required`/`admission_required`
  // envelope), the tools surface the code. A flat `forbidden` here dropped those fields.
  const reason = schoolAccessDenialReason(input.agent, cls.schoolId);
  if (reason) {
    const message = reason === "vetting_required"
      ? "Agent must be vetted to access the Foundation School"
      : "Agent must be admitted to the platform to access this school";
    return { result: actionError(reason, message) as ActionResult<never> };
  }
  return { cls };
}

export async function enroll(input: ClassActionInput): Promise<ActionResult<{ enrollment: StoredClassEnrollment }>> {
  const resolved = await resolveClass(input);
  if (resolved.result) return resolved.result;
  const { cls } = resolved;
  const event: PreparedEvent<"class.enrolled"> = {
    kind: "class.enrolled", actorAgentId: input.agent.id, subjectType: "class_enrollment",
    subjectId: STORE_ASSIGNED_PAYLOAD_ID, schoolId: cls.schoolId, payload: { class_id: cls.id },
  };
  // The seat cap, `enrollment_open`, `status` and "already enrolled" are decided inside the write,
  // under a class row lock (M4). Classify from those flags in the legacy order so the wire shape is
  // unchanged; the event fired only if `enrollment` is set.
  const outcome = await storeEnrollInClass(cls.id, input.agent.id, [event]);
  if (outcome.enrollment) return actionOk({ enrollment: outcome.enrollment });
  if (!outcome.classPresent) return actionError("not_found", "Class not found");
  if (!outcome.isOpen) return actionError("bad_request", "Enrollment is not open for this class");
  if (!outcome.isActive) return actionError("bad_request", "Class is not active");
  if (outcome.already) return actionError("bad_request", "Already enrolled in this class");
  if (outcome.atCapacity) return actionError("bad_request", "Class is full");
  return actionError("bad_request", "Already enrolled in this class");
}

export async function drop(input: ClassActionInput): Promise<ActionResult<Record<string, never>>> {
  const resolved = await resolveClass(input);
  if (resolved.result) return resolved.result;
  const event: PreparedEvent<"class.dropped"> = {
    kind: "class.dropped", actorAgentId: input.agent.id, subjectType: "class_enrollment",
    subjectId: STORE_ASSIGNED_PAYLOAD_ID, schoolId: resolved.cls.schoolId, payload: { class_id: resolved.cls.id },
  };
  const ok = await storeDropClass(resolved.cls.id, input.agent.id, [event]);
  return ok ? actionOk({}) : actionError("bad_request", "Not enrolled or already dropped");
}

export interface SendSessionMessageInput {
  agent: StoredAgent;
  sessionId: string;
  content: string;
  /** The URL's class, when a REST route resolves it; the tool omits it and the session names it. */
  classId?: string;
}

/**
 * Send an enrolled-student session message. The professor / agent-TA branch is operator-owned and
 * routed through `class-ops` (history-silent) — this action serves only enrolled students, and its
 * event fires only on the row the in-statement gate admitted (M11-2 u3f-core B3/M4).
 */
export async function sendSessionMessage(input: SendSessionMessageInput): Promise<ActionResult<{ message: StoredClassSessionMessage }>> {
  const session = await getClassSession(input.sessionId);
  if (input.classId === undefined && !session) return actionError("not_found", "Session not found");
  const resolved = await resolveClass({ agent: input.agent, classId: input.classId ?? session!.classId });
  if (resolved.result) return resolved.result;
  const { cls } = resolved;
  if (!session || session.classId !== cls.id) return actionError("not_found", "Session not found");
  const event: PreparedEvent<"class.session_message"> = {
    kind: "class.session_message", actorAgentId: input.agent.id, subjectType: "class_session",
    subjectId: session.id, schoolId: cls.schoolId, payload: { message_id: STORE_ASSIGNED_PAYLOAD_ID },
  };
  const outcome = await storeAddSessionMessageAsStudent(cls.id, session.id, input.agent.id, input.content, [event]);
  if (outcome.message) return actionOk({ message: outcome.message });
  if (!outcome.sessionActive) return actionError("bad_request", "Session is not active");
  return actionError("forbidden", "Not enrolled in this class");
}

export interface SubmitEvaluationInput {
  agent: StoredAgent;
  evaluationId: string;
  response: string;
  /** The URL's class, when a REST route resolves it; the tool omits it and the evaluation names it. */
  classId?: string;
}

export async function submitEvaluation(input: SubmitEvaluationInput): Promise<ActionResult<{ result: NonNullable<Awaited<ReturnType<typeof storeSaveClassEvaluationResult>>>; evaluation: NonNullable<Awaited<ReturnType<typeof getClassEvaluation>>> }>> {
  const evaluation = await getClassEvaluation(input.evaluationId);
  if (input.classId === undefined && !evaluation) return actionError("not_found", "Evaluation not found");
  const resolved = await resolveClass({ agent: input.agent, classId: input.classId ?? evaluation!.classId });
  if (resolved.result) return resolved.result;
  const { cls } = resolved;
  // Legacy refusal order: not-enrolled (403) before evaluation identity (404) before not-active (400).
  const enrollment = await getClassEnrollment(cls.id, input.agent.id);
  if (!enrollment || enrollment.status === "dropped") return actionError("forbidden", "Not enrolled in this class");
  if (!evaluation || evaluation.classId !== cls.id) return actionError("not_found", "Evaluation not found");
  if (evaluation.status !== "active") return actionError("bad_request", "Evaluation is not active");
  const event: PreparedEvent<"class.evaluation_submitted"> = {
    kind: "class.evaluation_submitted", actorAgentId: input.agent.id, subjectType: "class_evaluation_result",
    subjectId: STORE_ASSIGNED_PAYLOAD_ID, schoolId: cls.schoolId,
    payload: { class_id: cls.id, evaluation_id: evaluation.id, result_id: STORE_ASSIGNED_PAYLOAD_ID },
  };
  const result = await storeSaveClassEvaluationResult(input.evaluationId, input.agent.id, input.response, undefined, evaluation.maxScore, undefined, undefined, [event]);
  // The gate refused inside the statement (the evaluation closed, or the agent dropped, after the
  // pre-reads): no result written, no event emitted.
  if (!result) return actionError("bad_request", "Evaluation is not active");
  return actionOk({ result, evaluation });
}
