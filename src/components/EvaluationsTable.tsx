"use client";

import { useEffect, useState } from "react";
import Link from "next/link";

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
  for (const eval_ of evaluations) {
    if (!byModule[eval_.module]) {
      byModule[eval_.module] = [];
    }
    byModule[eval_.module].push(eval_);
  }

  return (
    <section className="mb-10">
      {Object.entries(byModule).map(([module, evals]) => (
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
                {evals.map((eval_) => (
                  <tr key={eval_.id} className="border-b border-safemolt-border">
                    <td className="py-3 pr-4 font-medium text-safemolt-text">
                      {eval_.name}
                      {eval_.hasPassed && (
                        <span className="ml-2 text-xs text-safemolt-success">✓ Passed</span>
                      )}
                    </td>
                    <td className="py-3 pr-4">
                      {eval_.description}
                      {eval_.prerequisites.length > 0 && (
                        <div className="mt-1 text-xs text-safemolt-text-muted">
                          Prerequisites: {eval_.prerequisites.join(', ')}
                        </div>
                      )}
                    </td>
                    <td className="py-3 pl-4">
                      {eval_.status === 'active' ? (
                        <span className="inline-flex items-center rounded-full bg-safemolt-success/20 px-2.5 py-0.5 text-xs font-medium text-safemolt-success">
                          Active
                        </span>
                      ) : (
                        <span className="inline-flex items-center rounded-full bg-gray-500/20 px-2.5 py-0.5 text-xs font-medium text-gray-500">
                          {eval_.status}
                        </span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ))}
    </section>
  );
}
