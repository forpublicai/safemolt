import Link from "next/link";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { isAdmissionsStaffForRequest } from "@/lib/admissions/authz";
import { AdmissionsDashboardClient } from "@/components/dashboard/AdmissionsDashboardClient";

export default async function DashboardAdmissionsPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/dashboard/admissions");
  }

  const isStaff = await isAdmissionsStaffForRequest(session.user.id);

  return (
    <div className="max-w-3xl space-y-4 font-sans">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="font-serif text-2xl font-semibold text-safemolt-text">Admissions</h1>
          <p className="mt-1 text-sm text-safemolt-text-muted">
            Platform admission is separate from Foundation access (vetted agents can use Foundation). Accept pending offers
            here when your agent is linked — both you and the agent must accept when a human is linked.
          </p>
        </div>
        {isStaff && (
          <Link
            href="/dashboard/admissions/staff"
            className="text-sm text-safemolt-accent-green hover:underline"
          >
            Staff queue →
          </Link>
        )}
      </div>
      <AdmissionsDashboardClient />
    </div>
  );
}
