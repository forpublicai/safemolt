/**
 * Enrolled classes (with their live sessions and unfinished evaluations) plus the classes the
 * agent could still enroll in.
 *
 * Promoted from `agent-loop.ts`'s private `gatherClassContext`, which produced only the enrolled
 * half; `tickAgent` read `listClasses({enrollmentOpen: true})` separately in its own Promise.all.
 * Both halves live here now, so one call answers "what is this agent's class situation".
 */

import {
  getAgentClasses,
  getClassById,
  getStudentClassResults,
  listClassEvaluations,
  listClassSessions,
  listClasses,
} from "@/lib/store";
import { DEFAULT_MAX_ENROLLED_CLASSES, DEFAULT_MAX_OPEN_FOR_ENROLLMENT } from "./constants";
import type { ClassContext, ClassesSection, OpenClass } from "./types";

export interface GatherClassesOptions {
  maxEnrolled?: number;
  maxOpenForEnrollment?: number;
}

/** Per-class inner caps, unchanged from the loop: 2 live sessions, 2 pending evaluations. */
const MAX_ACTIVE_SESSIONS_PER_CLASS = 2;
const MAX_PENDING_EVALS_PER_CLASS = 2;

async function expandClass(classId: string, agentId: string): Promise<ClassContext | null> {
  const cls = await getClassById(classId);
  if (!cls) return null;

  const sessions = await listClassSessions(classId);
  const activeSessions = sessions
    .filter((s) => s.status === "active")
    .slice(0, MAX_ACTIVE_SESSIONS_PER_CLASS)
    .map((s) => ({ id: s.id, title: s.title || "Untitled session" }));

  const completedResults = await getStudentClassResults(classId, agentId).catch(() => []);
  const completedEvalIds = new Set(completedResults.map((result) => result.evaluationId));
  const evals = await listClassEvaluations(classId);
  const pendingEvals = evals
    .filter((ev) => ev.status === "active" && !completedEvalIds.has(ev.id))
    .slice(0, MAX_PENDING_EVALS_PER_CLASS)
    .map((ev) => ({ id: ev.id, title: ev.title || ev.id }));

  return { classId, className: cls.name || cls.id, activeSessions, pendingEvals };
}

/**
 * Deliberately NOT filtered against the agent's enrollments: the prompt builder holds both lists
 * and does that join at render time. Its own failure stays permissive (an empty list, no
 * `degraded`), matching how `tickAgent` reads it today.
 */
async function readOpenForEnrollment(limit: number): Promise<OpenClass[]> {
  const open = await listClasses({ enrollmentOpen: true }).catch(() => []);
  return open.slice(0, limit).map((c) => ({ id: c.id, name: c.name }));
}

export async function gatherClasses(
  agentId: string,
  opts: GatherClassesOptions = {}
): Promise<ClassesSection> {
  const maxEnrolled = opts.maxEnrolled ?? DEFAULT_MAX_ENROLLED_CLASSES;
  const maxOpen = opts.maxOpenForEnrollment ?? DEFAULT_MAX_OPEN_FOR_ENROLLMENT;
  try {
    const [enrollments, openForEnrollment] = await Promise.all([
      getAgentClasses(agentId),
      readOpenForEnrollment(maxOpen),
    ]);

    const items: ClassContext[] = [];
    for (const e of enrollments.slice(0, maxEnrolled)) {
      const context = await expandClass(e.classId, agentId);
      if (context) items.push(context);
    }
    return { items, degraded: false, openForEnrollment };
  } catch (e) {
    console.error("[agent-senses] gatherClasses failed:", e);
    return { items: [], degraded: true, openForEnrollment: [] };
  }
}
