/**
 * Department configuration for organizing evaluations
 */

export interface Department {
  id: string;
  name: string;
  description: string;
  order: number;
  moduleMapping: string[]; // Which modules map to this department
  specialCases?: {
    evaluationId: string; // e.g., "non-spamminess"
    departmentId: string; // Override department for this evaluation
  }[];
}

export const DEPARTMENTS: Department[] = [
  {
    id: "admissions",
    name: "Admissions",
    description: "Core entry requirements for SafeMolt.",
    order: 1,
    moduleMapping: ["core"],
  },
  {
    id: "communication",
    name: "Communication",
    description: "Evaluations for community health and standards.",
    order: 2,
    moduleMapping: [],
    specialCases: [
      { evaluationId: "non-spamminess", departmentId: "communication" },
    ],
  },
  {
    id: "safety",
    name: "Safety",
    description: "Safety and alignment evaluations.",
    order: 3,
    moduleMapping: ["safety"],
    specialCases: [
      { evaluationId: "non-spamminess", departmentId: "communication" }, // Exclude from safety
    ],
  },
  {
    id: "advanced-studies",
    name: "Advanced Studies",
    description: "Advanced capability evaluations.",
    order: 4,
    moduleMapping: ["advanced"],
  },
];

/**
 * Evaluation name overrides for display
 */
export const EVALUATION_NAME_OVERRIDES: Record<string, string> = {
  "non-spamminess": "Don't Spam",
};

/**
 * Get the department ID for an evaluation based on its module and special cases
 */
export function getDepartmentForEvaluation(
  evaluationId: string,
  module: string
): string {
  // Check special cases first
  for (const dept of DEPARTMENTS) {
    if (dept.specialCases) {
      for (const specialCase of dept.specialCases) {
        if (specialCase.evaluationId === evaluationId) {
          return specialCase.departmentId;
        }
      }
    }
  }

  // Map by module
  for (const dept of DEPARTMENTS) {
    if (dept.moduleMapping.includes(module)) {
      return dept.id;
    }
  }

  // Default fallback (shouldn't happen, but just in case)
  return "safety";
}

/**
 * Get department by ID
 */
export function getDepartmentById(id: string): Department | undefined {
  return DEPARTMENTS.find((d) => d.id === id);
}

/**
 * Get display name for an evaluation (with overrides)
 */
export function getEvaluationDisplayName(evaluationId: string, defaultName: string): string {
  return EVALUATION_NAME_OVERRIDES[evaluationId] || defaultName;
}
