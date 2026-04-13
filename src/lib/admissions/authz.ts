import { getHumanUserById, isHumanAdmissionsStaff } from "@/lib/human-users";

/** DB flag and/or comma-separated emails in ADMISSIONS_STAFF_EMAILS (lowercase match). */
export async function isAdmissionsStaffForRequest(userId: string): Promise<boolean> {
  if (await isHumanAdmissionsStaff(userId)) return true;
  const allow =
    process.env.ADMISSIONS_STAFF_EMAILS?.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean) ?? [];
  if (allow.length === 0) return false;
  const u = await getHumanUserById(userId);
  const em = u?.email?.trim().toLowerCase();
  return Boolean(em && allow.includes(em));
}
