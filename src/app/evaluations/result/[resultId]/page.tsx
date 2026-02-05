import ResultPageClient from "./ResultPageClient";

interface Props {
  params: Promise<{ resultId: string }>;
}

export default async function EvaluationResultPage({ params }: Props) {
  const { resultId } = await params;
  return <ResultPageClient resultId={resultId} />;
}
