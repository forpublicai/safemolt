import { notFound } from "next/navigation";
import { getEvaluation, getEvaluationBySip } from "@/lib/evaluations/loader";
import { extractDescription } from "@/lib/evaluations/parser";
import {
  getEvaluationResults,
  getEvaluationVersions,
  getAgentById,
} from "@/lib/store";
import { EvaluationPageClient } from "./EvaluationPageClient";

interface Props {
  params: Promise<{ sip: string }>;
}

export default async function SIPPage({ params }: Props) {
  const { sip } = await params;

  const sipNum = parseInt(
    sip.startsWith("SIP-") ? sip.replace("SIP-", "") : sip,
    10
  );
  const evaluation = !Number.isNaN(sipNum)
    ? getEvaluationBySip(sipNum)
    : getEvaluation(sip);
  if (!evaluation) {
    notFound();
  }

  const description = extractDescription(evaluation.content);
  const [results, versions] = await Promise.all([
    getEvaluationResults(evaluation.id),
    getEvaluationVersions(evaluation.id),
  ]);

  const agentIds = new Set<string>();
  for (const r of results) {
    agentIds.add(r.agentId);
    if (r.proctorAgentId) agentIds.add(r.proctorAgentId);
  }
  const agentMap = new Map<string, string>();
  await Promise.all(
    Array.from(agentIds).map(async (id) => {
      const agent = await getAgentById(id);
      agentMap.set(id, agent?.name ?? id);
    })
  );

  const resultsWithNames = results.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    agentName: agentMap.get(r.agentId) ?? r.agentId,
    passed: r.passed,
    score: r.score,
    maxScore: r.maxScore,
    pointsEarned: r.pointsEarned,
    completedAt: r.completedAt,
    evaluationVersion: r.evaluationVersion,
    proctorAgentId: r.proctorAgentId,
    proctorName: r.proctorAgentId
      ? agentMap.get(r.proctorAgentId) ?? undefined
      : undefined,
    proctorFeedback: r.proctorFeedback,
  }));

  return (
    <EvaluationPageClient
      evaluation={{
        id: evaluation.id,
        name: evaluation.name,
        sip: evaluation.sip,
        description: description || "No description available.",
        currentVersion: evaluation.version ?? "1.0.0",
      }}
      versions={versions}
      results={resultsWithNames}
    />
  );
}
