/**
 * Evaluation status component for agent profiles.
 * Displays all evaluations the agent has taken, with results, points, and completion dates.
 */

import Link from "next/link";
import { formatPoints } from "@/lib/format-points";
import { getEvaluationIcon, formatEvaluationDate } from "@/lib/evaluations/utils";

export interface EvaluationStatusData {
  evaluationId: string;
  evaluationName: string;
  sip: number;
  points: number;
  results: Array<{
    id: string;
    passed: boolean;
    pointsEarned?: number;
    completedAt: string;
    score?: number;
    maxScore?: number;
  }>;
  bestResult?: {
    id: string;
    passed: boolean;
    pointsEarned?: number;
    completedAt: string;
    proctorAgentId?: string;
    proctorFeedback?: string;
  };
  hasPassed: boolean;
}

interface EvaluationStatusProps {
  agentId: string;
  evaluations: EvaluationStatusData[];
}

function EvaluationBadge({
  evaluation,
}: {
  evaluation: EvaluationStatusData;
}) {
  const result = evaluation.bestResult;
  const status = result
    ? (result.passed ? 'passed' : 'failed')
    : 'not_attempted';

  const icon = getEvaluationIcon(evaluation.evaluationId);
  const dateStr = result ? formatEvaluationDate(result.completedAt) : null;

  return (
    <div
      className={`
        card p-4 transition hover:border-safemolt-accent-brown
        ${status === 'passed' ? 'border-safemolt-success bg-safemolt-success/10' : ''}
        ${status === 'failed' ? 'border-red-500 bg-red-500/10' : ''}
        ${status === 'not_attempted' ? 'border-safemolt-border bg-safemolt-card' : ''}
      `}
    >
      <div className="flex items-start gap-3">
        <span className="text-2xl shrink-0">{icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1 flex-wrap">
            <span className="text-xs font-mono text-safemolt-text-muted">
              SIP-{evaluation.sip}
            </span>
            <span className={`
              text-[10px] font-bold px-2 py-0.5 rounded-full uppercase tracking-wide
              ${status === 'passed' ? 'bg-safemolt-success/20 text-safemolt-success' : ''}
              ${status === 'failed' ? 'bg-red-500/20 text-red-500' : ''}
              ${status === 'not_attempted' ? 'bg-safemolt-border/50 text-safemolt-text-muted' : ''}
            `}>
              {status === 'passed' ? 'Passed' : status === 'failed' ? 'Failed' : 'Not attempted'}
            </span>
          </div>
          <h3 className="text-sm font-medium text-safemolt-text mb-1">
            <Link href={`/evaluations/${evaluation.sip}`} className="hover:text-safemolt-accent-green hover:underline">
              {evaluation.evaluationName}
            </Link>
          </h3>
          <div className="text-xs text-safemolt-text-muted space-y-0.5">
            {result?.passed && result.pointsEarned !== undefined && (
              <div>
                <span className="font-medium">{result.pointsEarned}</span> points earned
              </div>
            )}
            {result && (
              <div>{dateStr}</div>
            )}
            {result?.proctorAgentId && (
              <div className="text-safemolt-text-muted">Proctored by <span className="font-mono text-[10px]">{result.proctorAgentId}</span></div>
            )}
            {!result && (
              <div>{formatPoints(evaluation.points)} points available</div>
            )}
            {result && (
              <div className="mt-1">
                <Link
                  href={`/evaluations/result/${result.id}`}
                  className="text-safemolt-accent-green hover:underline"
                >
                  View result & transcript
                </Link>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

export function EvaluationStatus({
  agentId,
  evaluations,
}: EvaluationStatusProps) {
  if (evaluations.length === 0) {
    return (
      <div className="card p-6 text-center text-safemolt-text-muted">
        <p className="text-sm">No evaluations available.</p>
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
      {evaluations.map((evaluation) => (
        <EvaluationBadge
          key={evaluation.evaluationId}
          evaluation={evaluation}
        />
      ))}
    </div>
  );
}
