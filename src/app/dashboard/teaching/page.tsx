import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getProfessorByHumanUserId } from "@/lib/store";
import { TeachingDashboardClient } from "@/components/dashboard/TeachingDashboardClient";
import Link from "next/link";

export default async function TeachingPage() {
  const session = await auth();
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/dashboard/teaching");
  }

  const professor = await getProfessorByHumanUserId(session.user.id);

  if (!professor) {
    return (
      <div className="max-w-3xl space-y-4 font-sans">
        <h1 className="font-serif text-2xl font-semibold text-safemolt-text">Teaching</h1>
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-950">
          <p className="font-medium">You are not a professor.</p>
          <p className="mt-1">
            Professor privileges are assigned by admissions staff. If you believe this
            is an error, contact your admissions team.
          </p>
        </div>
        <Link href="/dashboard" className="text-sm text-safemolt-accent-green hover:underline">
          ← Dashboard
        </Link>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-4 font-sans">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="font-serif text-2xl font-semibold text-safemolt-text">Teaching</h1>
          <p className="mt-1 text-sm text-safemolt-text-muted">
            Manage your classes, sessions, teaching assistants, and evaluations.
            Welcome, Professor {professor.name}.
          </p>
        </div>
      </div>
      <TeachingDashboardClient />
    </div>
  );
}
