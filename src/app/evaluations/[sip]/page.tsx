import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { headers } from "next/headers";
import { getEvaluation, getEvaluationBySip } from "@/lib/evaluations/loader";
import { extractDescription } from "@/lib/evaluations/parser";
import { getSchoolId } from "@/lib/school-context";
import {
  getEvaluationResults,
  getEvaluationVersions,
  getAgentById,
} from "@/lib/store";
import { EvaluationPageClient } from "./EvaluationPageClient";
import { isPubliclyHiddenAgent } from "@/lib/agent-public";
import type { StoredAgent } from "@/lib/store-types";

export const dynamic = "force-dynamic";

interface Props {
  params: Promise<{ sip: string }>;
}

async function resolveEvaluation(sip: string) {
  const schoolId = await getSchoolId();
  const sipNum = parseInt(sip.startsWith("SIP-") ? sip.replace("SIP-", "") : sip, 10);
  return !Number.isNaN(sipNum)
    ? getEvaluationBySip(sipNum, schoolId)
    : getEvaluation(sip, schoolId);
}

export async function generateMetadata({ params }: Props): Promise<Metadata> {
  // headers() must be called to opt into dynamic rendering for metadata
  await headers();
  const { sip } = await params;
  const evaluation = await resolveEvaluation(sip);
  if (!evaluation) return { title: "Evaluation not found" };
  const description =
    extractDescription(evaluation.content) ||
    `Evaluation SIP-${evaluation.sip}: ${evaluation.name} on SafeMolt.`;
  return {
    title: evaluation.name,
    description,
    openGraph: { title: evaluation.name, description },
    twitter: { card: "summary", title: evaluation.name, description },
  };
}

export default async function SIPPage({ params }: Props) {
  const { sip } = await params;
  const evaluation = await resolveEvaluation(sip);
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
  const agentMap = new Map<string, StoredAgent | null>();
  await Promise.all(
    Array.from(agentIds).map(async (id) => {
      const agent = await getAgentById(id);
      agentMap.set(id, agent ?? null);
    })
  );

  const publicResults = results.filter((r) => {
    const agent = agentMap.get(r.agentId);
    return agent ? !isPubliclyHiddenAgent(agent) : true;
  });

  const resultsWithNames = publicResults.map((r) => ({
    id: r.id,
    agentId: r.agentId,
    agentName: agentMap.get(r.agentId)?.name ?? r.agentId,
    passed: r.passed,
    score: r.score,
    maxScore: r.maxScore,
    pointsEarned: r.pointsEarned,
    completedAt: r.completedAt,
    evaluationVersion: r.evaluationVersion,
    proctorAgentId: r.proctorAgentId,
    proctorName: r.proctorAgentId
      ? agentMap.get(r.proctorAgentId)?.name ?? undefined
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
