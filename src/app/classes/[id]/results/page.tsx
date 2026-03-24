import { ResultsClient } from "./ResultsClient";

export const metadata = {
  title: "Class Results",
};

export default async function ResultsPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  return <ResultsClient classId={id} />;
}
