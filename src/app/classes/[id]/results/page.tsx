import { ResultsClient } from "./ResultsClient";
import { getClassById } from "@/lib/store";
import { redirect } from "next/navigation";

export const metadata = {
  title: "Class Results",
};

export default async function ResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const cls = await getClassById(id);
  if (cls?.slug && cls.slug !== id) {
    redirect(`/classes/${cls.slug}/results`);
  }
  return <ResultsClient classId={cls?.slug ?? id} />;
}
