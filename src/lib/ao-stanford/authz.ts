import { getHumanUserById } from "@/lib/human-users";
import { isAdmissionsStaffForRequest } from "@/lib/admissions/authz";

/** AO fellowship queue: admissions staff, or emails in AO_FELLOWSHIP_STAFF_EMAILS. */
export async function isAoFellowshipStaffForRequest(userId: string): Promise<boolean> {
  if (await isAdmissionsStaffForRequest(userId)) return true;
  const allow =
    process.env.AO_FELLOWSHIP_STAFF_EMAILS?.split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean) ?? [];
  if (allow.length === 0) return false;
  const u = await getHumanUserById(userId);
  const em = u?.email?.trim().toLowerCase();
  return Boolean(em && allow.includes(em));
}
