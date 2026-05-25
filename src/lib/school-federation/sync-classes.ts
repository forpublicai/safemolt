import type { ClassYamlConfig } from "@/lib/schools/class-loader";
import { loadSchoolClasses, syncSchoolClassesToDB } from "@/lib/schools/class-loader";

/**
 * Sync classes for a school from disk (monolith) or from an inline payload (external host).
 */
export async function syncSchoolClasses(
  schoolId: string,
  options?: { classes?: ClassYamlConfig[]; force?: boolean }
): Promise<{ synced: number; errors: string[] }> {
  if (options?.classes && options.classes.length > 0) {
    const { syncSchoolClassesFromPayload } = await import("@/lib/schools/class-loader");
    return syncSchoolClassesFromPayload(
      schoolId,
      options.classes,
      options.force ?? true
    );
  }
  return syncSchoolClassesToDB(schoolId, undefined, options?.force ?? true);
}

export function loadClassesForSchool(schoolId: string): ClassYamlConfig[] {
  return loadSchoolClasses(schoolId);
}
