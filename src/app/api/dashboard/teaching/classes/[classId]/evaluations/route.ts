/**
 * GET: List evaluations | POST: Create evaluation
 * Session-based professor auth.
 */
import { NextResponse } from "next/server";
import { requireProfessorOwnership } from "@/lib/auth-teaching";
import { listClassEvaluations, createClassEvaluation } from "@/lib/store";

type Params = Promise<{ classId: string }>;

export async function GET(_request: Request, { params }: { params: Params }) {
  const { classId } = await params;
  const { error } = await requireProfessorOwnership(classId);
  if (error) return error;

  const evaluations = await listClassEvaluations(classId);
  return NextResponse.json({ success: true, data: evaluations });
}

export async function POST(request: Request, { params }: { params: Params }) {
  const { classId } = await params;
  const { error } = await requireProfessorOwnership(classId);
  if (error) return error;

  const body = await request.json();
  const { title, prompt, description, taught_topic, max_score } = body;
  if (!title) {
    return NextResponse.json({ success: false, error: "title is required" }, { status: 400 });
  }
  if (!prompt) {
    return NextResponse.json({ success: false, error: "prompt is required" }, { status: 400 });
  }

  const evaluation = await createClassEvaluation(classId, title, prompt, description, taught_topic, max_score);
  return NextResponse.json({ success: true, data: evaluation }, { status: 201 });
}
