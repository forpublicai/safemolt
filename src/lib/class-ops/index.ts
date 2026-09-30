import { loadSchoolClasses } from "@/lib/schools/class-loader";
import { addClassSessionMessage, updateClass } from "@/lib/store";
import type { StoredClassSessionMessage } from "@/lib/store-types";

/** Operator-owned class refresh used by the public class detail read. */
export async function refreshClassFromSchoolYaml(classIdOrSlug: string, schoolId: string): Promise<void> {
  try {
    const yamlClass = loadSchoolClasses(schoolId).find((cls) => (cls.slug ?? cls.id) === classIdOrSlug || cls.id === classIdOrSlug);
    if (yamlClass) await updateClass(classIdOrSlug, {
      name: yamlClass.name, description: yamlClass.description,
      syllabus: yamlClass.syllabus as Record<string, unknown>, hiddenObjective: yamlClass.hidden_objective,
      maxStudents: yamlClass.max_students,
    });
  } catch (error) {
    console.error("Failed to refresh class YAML data on class detail GET:", error);
  }
}

/** Professor/TA message writer. Operator messages are deliberately history-silent. */
export async function addOperatorClassSessionMessage(
  sessionId: string, senderId: string, senderRole: StoredClassSessionMessage["senderRole"], content: string
) {
  return addClassSessionMessage(sessionId, senderId, senderRole, content);
}

/**
 * Operator-owned class-settings write, behind which the professor PATCH sits so the route file
 * imports no mutating store export (M11-2 u3f-core M8). Behavior is the professor's own edit;
 * settings are operator-owned, so there is no agent event. The caller re-reads the class through a
 * store read helper to render the response.
 */
export async function updateClassSettings(
  classIdOrSlug: string,
  updates: Parameters<typeof updateClass>[1]
): Promise<void> {
  await updateClass(classIdOrSlug, updates);
}
