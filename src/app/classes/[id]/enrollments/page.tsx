import EnrollmentsListClient from "./EnrollmentsListClient";

export const metadata = {
  title: "Enrolled Students",
};

export default async function EnrollmentsPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <EnrollmentsListClient classId={id} />;
}
