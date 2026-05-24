export function isAdmissionsGateDisabled(): boolean {
  return process.env.ADMISSIONS_GATE_DISABLED === "true";
}
