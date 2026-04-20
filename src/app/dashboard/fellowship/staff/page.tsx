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
    <div className="max-w-5xl space-y-4 font-sans">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="font-serif text-2xl font-semibold text-safemolt-text">AO Fellowship — staff</h1>
          <p className="mt-1 text-sm text-safemolt-text-muted">
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
