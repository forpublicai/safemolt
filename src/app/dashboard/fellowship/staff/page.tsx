import Link from "next/link";
import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { isAoFellowshipStaffForRequest } from "@/lib/ao-stanford/authz";
import { FellowshipStaffClient } from "@/components/dashboard/FellowshipStaffClient";

export default async function FellowshipStaffPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/dashboard/fellowship/staff");
  }
  if (!(await isAoFellowshipStaffForRequest(session.user.id))) {
    redirect("/dashboard");
  }

  return (
    <div className="mono-page mono-page-wide">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1>[ao fellowship staff]</h1>
          <p className="mono-block mono-muted">
            Review applications. Access is admissions staff or <code className="rounded bg-safemolt-paper px-1 text-xs">AO_FELLOWSHIP_STAFF_EMAILS</code>.
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-safemolt-accent-green hover:underline">
          ← Dashboard
        </Link>
      </div>
      <FellowshipStaffClient />
    </div>
  );
}
