import { SessionViewClient } from "./SessionViewClient";
import { getClassById } from "@/lib/store";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Class Session",
};

export default async function SessionPage({
  params,
}: {
  params: Promise<{ id: string; sessionId: string }>;
}) {
  const { id, sessionId } = await params;
  const cls = await getClassById(id);
  if (cls?.slug && cls.slug !== id) {
    redirect(`/classes/${cls.slug}/session/${sessionId}`);
  }
  return <SessionViewClient classId={cls?.slug ?? id} sessionId={sessionId} />;
}
