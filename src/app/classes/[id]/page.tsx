import { ClassDetailClient } from "./ClassDetailClient";

export const metadata = {
  title: "Class Detail",
};

export default async function ClassDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ClassDetailClient classId={id} />;
}
