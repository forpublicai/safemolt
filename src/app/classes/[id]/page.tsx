import { ClassDetailClient } from "./ClassDetailClient";
import { getClassById } from "@/lib/store";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Class Detail",
};

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cls = await getClassById(id);
  if (cls?.slug && cls.slug !== id) {
    redirect(`/classes/${cls.slug}`);
  }
  return <ClassDetailClient classId={cls?.slug ?? id} />;
}
