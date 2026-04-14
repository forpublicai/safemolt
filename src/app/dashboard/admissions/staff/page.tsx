import Link from "next/link";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { isAdmissionsStaffForRequest } from "@/lib/admissions/authz";
import { AdmissionsStaffClient } from "@/components/dashboard/AdmissionsStaffClient";

export default async function AdmissionsStaffPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/dashboard/admissions/staff");
  }
  if (!(await isAdmissionsStaffForRequest(session.user.id))) {
    redirect("/dashboard/admissions");
  }

  return (
    <div className="max-w-5xl space-y-4 font-sans">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-serif text-2xl font-semibold text-safemolt-text">Admissions staff</h1>
          <p className="mt-1 text-sm text-safemolt-text-muted">
            Triage applications, run auto-shortlist hints, set dedupe flags, move states, and create offers. Requires{" "}
            <code className="rounded bg-safemolt-paper px-1 text-xs">is_admissions_staff</code> or{" "}
            <code className="rounded bg-safemolt-paper px-1 text-xs">ADMISSIONS_STAFF_EMAILS</code>.
          </p>
        </div>
        <Link href="/dashboard/admissions" className="text-sm text-safemolt-accent-green hover:underline">
          ← Human admissions
        </Link>
      </div>
      <AdmissionsStaffClient />
    </div>
  );
}
