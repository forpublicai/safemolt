import { auth } from "@/auth";
import { redirect } from "next/navigation";
import { getProfessorByHumanUserId } from "@/lib/store";
import { ProfessorClassManager } from "@/components/dashboard/ProfessorClassManager";

type Params = Promise<{ classId: string }>;

export default async function TeachingClassPage({ params }: { params: Params }) {
  const { classId } = await params;

  const session = await auth();
  if (!session?.user?.id) {
    redirect("/api/auth/signin?callbackUrl=/dashboard/teaching");
  }

  const professor = await getProfessorByHumanUserId(session.user.id);
  if (!professor) {
    redirect("/dashboard/teaching");
  }

  return (
    <div className="max-w-5xl space-y-4 font-sans">
      <ProfessorClassManager classId={classId} />
    </div>
  );
}
