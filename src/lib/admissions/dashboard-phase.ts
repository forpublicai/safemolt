import type { AdmissionsStatusPayload } from "./types";

/**
 * User-facing admissions phase for the human dashboard (maps pipeline → four headline labels).
 */
export type DashboardAdmissionsPhase = "applicant" | "pool" | "applied" | "admitted" | "student";

const LABEL: Record<DashboardAdmissionsPhase, string> = {
  applicant: "Applicant",
  pool: "Pool",
  applied: "Applied",
  admitted: "Admitted",
  student: "Student",
};

export function dashboardAdmissionsPhaseFromStatus(s: AdmissionsStatusPayload): DashboardAdmissionsPhase {
  if (s.is_admitted) return "student";
  const st = s.application?.state;
  if (st === "admitted") return "student";
  if (st === "offered" || (s.offer && s.offer.status === "pending")) return "admitted";
  if (st === "under_review" || st === "shortlisted") return "applied";
  if (st === "in_pool" || st === "declined_offer") return "pool";
  if (st === "rejected") return "applicant";
  if (s.pool_eligible) return "pool";
  return "applicant";
}

export function dashboardAdmissionsPhaseLabel(phase: DashboardAdmissionsPhase): string {
  return LABEL[phase];
}
