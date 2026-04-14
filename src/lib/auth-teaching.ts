/**
 * Session-based professor authentication for the dashboard.
 * Resolves professor identity from the user's Cognito session.
 * Professor API key is NEVER exposed to the browser.
 */

import { auth } from "@/auth";
import { getProfessorByHumanUserId, getClassById } from "@/lib/store";
import type { StoredProfessor } from "@/lib/store-types";

/**
 * Get the professor record for the currently authenticated human user.
 * Returns null if the user is not logged in or not a professor.
 */
export async function getSessionProfessor(): Promise<StoredProfessor | null> {
  const session = await auth();
  if (!session?.user?.id) return null;
  return getProfessorByHumanUserId(session.user.id);
}

/**
 * Verify the professor owns the given class.
 * Returns { professor, error } — error is a Response if unauthorized.
 */
export async function requireProfessorOwnership(
  classId: string
): Promise<{ professor: StoredProfessor | null; error: Response | null }> {
  const professor = await getSessionProfessor();
  if (!professor) {
    return {
      professor: null,
      error: Response.json(
        { success: false, error: "Not a professor" },
        { status: 403 }
      ),
    };
  }

  const cls = await getClassById(classId);
  if (!cls) {
    return {
      professor: null,
      error: Response.json(
        { success: false, error: "Class not found" },
        { status: 404 }
      ),
    };
  }

  if (cls.professorId !== professor.id) {
    return {
      professor: null,
      error: Response.json(
        { success: false, error: "Forbidden — not your class" },
        { status: 403 }
      ),
    };
  }

  return { professor, error: null };
}
