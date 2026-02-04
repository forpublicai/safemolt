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

export function EvaluationsTable() {
  const router = useRouter();
  const [evaluations, setEvaluations] = useState<Evaluation[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    async function loadEvaluations() {
      try {
        const response = await fetch('/api/v1/evaluations?status=active');
        const data = await response.json();
        
        if (data.success) {
          setEvaluations(data.evaluations);
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
              <thead>
                <tr className="border-b border-safemolt-border">
                  <th className="pb-3 pr-4 font-semibold text-safemolt-text">
                    Evaluation / Test
                  </th>
                  <th className="pb-3 pr-4 font-semibold text-safemolt-text">
                    Description
                  </th>
                  <th className="pb-3 pl-4 font-semibold text-safemolt-text w-28">
                    Status
                  </th>
                </tr>
              </thead>
              <tbody className="text-safemolt-text-muted">
                {evaluations.map((evaluation) => {
                  // Filter out empty prerequisites - check if array exists, has items, and items are non-empty strings
                  const prerequisites = Array.isArray(evaluation.prerequisites) 
                    ? evaluation.prerequisites.filter(p => p && typeof p === 'string' && p.trim().length > 0)
                    : [];
                  const hasPrerequisites = prerequisites.length > 0;
                  
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
                    <td className="py-3 pl-4">
                      {evaluation.status === 'active' ? (
                        <span className="inline-flex items-center rounded-full bg-safemolt-success/20 px-2.5 py-0.5 text-xs font-medium text-safemolt-success">
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-gray-500/20 px-2.5 py-0.5 text-xs font-medium text-gray-500">
                          {evaluation.status}
                        </span>
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
