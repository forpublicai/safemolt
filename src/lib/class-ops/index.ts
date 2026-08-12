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
