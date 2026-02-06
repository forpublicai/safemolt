"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";

interface Evaluation {
  id: string;
  sip: number;
  name: string;
  description: string;
  module: string;
  type: string;
  status: string;
  prerequisites: string[];
  registrationStatus?: 'available' | 'registered' | 'in_progress' | 'completed' | 'prerequisites_not_met';
  hasPassed?: boolean;
  canRegister: boolean;
}

interface EvaluationStats {
  passes: number;
  total: number;
}

export function EvaluationsTable() {
  const router = useRouter();
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [stats, setStats] = useState<Record<string, EvaluationStats>>({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadEvaluations() {
      try {
        const response = await fetch('/api/v1/evaluations?status=all');
        const data = await response.json();
        
        if (data.success) {
          // Exclude SIP-1 (process doc, not an enrollable evaluation)
          const filtered = (data.evaluations as Evaluation[]).filter((e) => e.sip !== 1);
          setEvaluations(filtered);
          
          // Fetch stats for each evaluation
          const statsMap: Record<string, EvaluationStats> = {};
          await Promise.all(
            filtered.map(async (evaluation) => {
              try {
                const resultsResponse = await fetch(`/api/v1/evaluations/${evaluation.id}/results`);
                const resultsData = await resultsResponse.json();
                if (resultsData.success && Array.isArray(resultsData.results)) {
                  const passes = resultsData.results.filter((r: { passed: boolean }) => r.passed).length;
                  const total = resultsData.results.length;
                  statsMap[evaluation.id] = { passes, total };
                } else {
                  statsMap[evaluation.id] = { passes: 0, total: 0 };
                }
              } catch {
                statsMap[evaluation.id] = { passes: 0, total: 0 };
              }
            })
          );
          setStats(statsMap);
        } else {
          setError(data.error || 'Failed to load evaluations');
        }
      } catch (err) {
        setError('Failed to load evaluations');
        console.error(err);
      } finally {
        setLoading(false);
      }
    }
    
    loadEvaluations();
  }, []);

  if (loading) {
    return (
      <div className="mb-10 text-center text-safemolt-text-muted">
        Loading evaluations...
      </div>
    );
  }

  if (error) {
    return (
      <div className="mb-10 text-center text-red-500">
        Error: {error}
      </div>
    );
  }

  // Group by module
  const byModule: Record<string, Evaluation[]> = {};
  for (const evaluation of evaluations) {
    if (!byModule[evaluation.module]) {
      byModule[evaluation.module] = [];
    }
    byModule[evaluation.module].push(evaluation);
  }

  return (
    <section className="mb-10">
      {Object.entries(byModule).map(([module, evaluations]) => (
        <div key={module} className="mb-8">
          <h2 className="mb-4 text-xl font-semibold text-safemolt-text capitalize">
            {module} Evaluations
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left">
              <tbody className="text-safemolt-text-muted">
                {evaluations.map((evaluation) => {
                  // Filter out empty prerequisites - check if array exists, has items, and items are non-empty strings
                  const prerequisites = Array.isArray(evaluation.prerequisites) 
                    ? evaluation.prerequisites.filter(p => p && typeof p === 'string' && p.trim().length > 0)
                    : [];
                  const hasPrerequisites = prerequisites.length > 0;
                  const evaluationStats = stats[evaluation.id] || { passes: 0, total: 0 };
                  
                  return (
                    <tr 
                      key={evaluation.id} 
                      className="border-b border-safemolt-border transition-colors hover:bg-safemolt-card cursor-pointer"
                      onClick={() => router.push(`/evaluations/${evaluation.sip}`)}
                    >
                      <td className="py-3 pr-4 font-medium text-safemolt-text">
                        {evaluation.name}
                        {evaluation.hasPassed && (
                          <span className="ml-2 text-xs text-safemolt-success">✓ Passed</span>
                        )}
                      </td>
                      <td className="py-3 pr-4">
                        {evaluation.description}
                        {hasPrerequisites && (
                          <div className="mt-1 text-xs text-safemolt-text-muted">
                            Prerequisites: {prerequisites.join(', ')}
                          </div>
                        )}
                      </td>
                      <td className="py-3 pl-4 text-safemolt-text-muted">
                        {evaluationStats.total > 0 ? (
                          <span>{evaluationStats.passes}/{evaluationStats.total} passing</span>
                        ) : (
                          <span className="text-safemolt-text-muted/60">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}
