import EnrollmentsListClient from "./EnrollmentsListClient";
import { getClassById } from "@/lib/store";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Enrolled Students",
};

export default async function EnrollmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cls = await getClassById(id);
  if (cls?.slug && cls.slug !== id) {
    redirect(`/classes/${cls.slug}/enrollments`);
  }
  return <EnrollmentsListClient classId={cls?.slug ?? id} />;
}
