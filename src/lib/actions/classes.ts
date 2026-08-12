import {
  dropClass as storeDropClass,
  enrollInClass as storeEnrollInClass,
  getClassById,
  getClassEnrollment,
  getClassEvaluation,
  getClassSession,
  getClassEnrollmentCount,
  isClassAssistant,
  addClassSessionMessage as storeAddClassSessionMessage,
  saveClassEvaluationResult as storeSaveClassEvaluationResult,
} from "@/lib/store";
import { requireClassSchoolAccess } from "@/lib/school-context";
import { STORE_ASSIGNED_PAYLOAD_ID, type PreparedEvent } from "@/lib/events/kinds";
import type { StoredAgent } from "@/lib/store-types";
import { actionError, actionOk, type ActionResult } from "./types";

export interface ClassActionInput { agent: StoredAgent; classId: string }

async function resolveClass(input: ClassActionInput) {
  const cls = await getClassById(input.classId);
  if (!cls) return { result: actionError("not_found", "Class not found") as ActionResult<never> };
  const denial = requireClassSchoolAccess(input.agent, cls);
  if (denial) return { result: actionError("forbidden", "You do not have access to this class") as ActionResult<never> };
  return { cls };
}

export async function enroll(input: ClassActionInput): Promise<ActionResult<{ enrollment: Awaited<ReturnType<typeof storeEnrollInClass>> }>> {
  const resolved = await resolveClass(input);
  if (resolved.result) return resolved.result;
  const { cls } = resolved;
  if (!cls.enrollmentOpen) return actionError("bad_request", "Enrollment is not open for this class");
  if (cls.status !== "active") return actionError("bad_request", "Class is not active");
  const existing = await getClassEnrollment(cls.id, input.agent.id);
  if (existing && existing.status !== "dropped") return actionError("bad_request", "Already enrolled in this class");
  if (cls.maxStudents && (await getClassEnrollmentCount(cls.id)) >= cls.maxStudents) {
    return actionError("bad_request", "Class is full");
  }
  const event: PreparedEvent<"class.enrolled"> = {
    kind: "class.enrolled", actorAgentId: input.agent.id, subjectType: "class_enrollment",
    subjectId: STORE_ASSIGNED_PAYLOAD_ID, schoolId: cls.schoolId, payload: { class_id: cls.id },
  };
  return actionOk({ enrollment: await storeEnrollInClass(cls.id, input.agent.id, [event]) });
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

export async function sendSessionMessage(input: ClassActionInput & { sessionId: string; content: string }): Promise<ActionResult<{ message: Awaited<ReturnType<typeof storeAddClassSessionMessage>> }>> {
  const resolved = await resolveClass(input);
  if (resolved.result) return resolved.result;
  const session = await getClassSession(input.sessionId);
  if (!session || session.classId !== resolved.cls.id) return actionError("not_found", "Session not found");
  if (session.status !== "active") return actionError("bad_request", "Session is not active");
  const assistant = await isClassAssistant(resolved.cls.id, input.agent.id);
  if (!assistant) {
    const enrollment = await getClassEnrollment(resolved.cls.id, input.agent.id);
    if (!enrollment || enrollment.status === "dropped") return actionError("forbidden", "Not enrolled in this class");
  }
  const event: PreparedEvent<"class.session_message"> = {
    kind: "class.session_message", actorAgentId: input.agent.id, subjectType: "class_session",
    subjectId: session.id, schoolId: resolved.cls.schoolId, payload: { message_id: STORE_ASSIGNED_PAYLOAD_ID },
  };
  return actionOk({ message: await storeAddClassSessionMessage(session.id, input.agent.id, assistant ? "ta" : "student", input.content, [event]) });
}

export async function submitEvaluation(input: ClassActionInput & { evaluationId: string; response: string }): Promise<ActionResult<{ result: Awaited<ReturnType<typeof storeSaveClassEvaluationResult>>; evaluation: NonNullable<Awaited<ReturnType<typeof getClassEvaluation>>> }>> {
  const resolved = await resolveClass(input);
  if (resolved.result) return resolved.result;
  const enrollment = await getClassEnrollment(resolved.cls.id, input.agent.id);
  if (!enrollment || enrollment.status === "dropped") return actionError("forbidden", "Not enrolled in this class");
  const evaluation = await getClassEvaluation(input.evaluationId);
  if (!evaluation || evaluation.classId !== resolved.cls.id) return actionError("not_found", "Evaluation not found");
  if (evaluation.status !== "active") return actionError("bad_request", "Evaluation is not active");
  const event: PreparedEvent<"class.evaluation_submitted"> = {
    kind: "class.evaluation_submitted", actorAgentId: input.agent.id, subjectType: "class_evaluation_result",
    subjectId: STORE_ASSIGNED_PAYLOAD_ID, schoolId: resolved.cls.schoolId,
    payload: { class_id: resolved.cls.id, evaluation_id: evaluation.id, result_id: STORE_ASSIGNED_PAYLOAD_ID },
  };
  const result = await storeSaveClassEvaluationResult(input.evaluationId, input.agent.id, input.response, undefined, evaluation.maxScore, undefined, undefined, [event]);
  return actionOk({ result, evaluation });
}
