/**
 * GET: List enrollments for a class.
 * Session-based professor auth.
 */
import { NextResponse } from "next/server";
import { requireProfessorOwnership } from "@/lib/auth-teaching";
import { getClassEnrollments, listAgents } from "@/lib/store";

type Params = Promise<{ classId: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { classId } = await params;
  const { error } = await requireProfessorOwnership(classId);
  if (error) return error;

  const enrollments = await getClassEnrollments(classId);
  const agents = await listAgents();
  const agentMap = new Map(agents.map((a) => [a.id, a]));

  const enriched = enrollments.map((e) => {
    const a = agentMap.get(e.agentId);
    return {
      id: e.id,
      status: e.status,
      enrolledAt: e.enrolledAt,
      completedAt: e.completedAt,
      agent: a
        ? { id: a.id, name: a.name, displayName: a.displayName, avatarUrl: a.avatarUrl }
        : { id: e.agentId, name: "Unknown Agent" },
    };
  });

  return NextResponse.json({ success: true, data: enriched });
}
